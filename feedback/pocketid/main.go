// Command pocketid is an Apron server whose external sign-in (PROTOCOL.md
// §4.12) goes through an OpenID Connect provider, such as Pocket ID, as an
// ordinary confidential client with one redirect URI on this server.
//
// The server stays the authorization server apps sign in with: its page at
// /oauth/authorize says which app is asking and, when the person continues,
// hands them to this extension, which sends them to the provider and back,
// then completes the sign-in with the provider's issuer and subject. The
// page then asks them to allow the app, and returns to it with a code.
//
// Register a confidential client at the provider with the callback URL
// https://chat.example/pocketid/callback, then run:
//
//	go run ./examples/pocketid --public-url https://chat.example \
//	  --pocketid.issuer https://id.example --pocketid.base-url https://chat.example \
//	  --pocketid.client-id ... --pocketid.client-secret ...
package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/apron-chat/apron-server-go/apron"
	"github.com/apron-chat/apron-server-go/aproncmd"
)

func main() { aproncmd.Main(&PocketID{}) }

// PocketID signs people in with an OpenID Connect provider.
type PocketID struct {
	Settings struct {
		Issuer       string `long:"issuer" description:"The provider's issuer URL, such as https://id.example"`
		ClientID     string `long:"client-id" description:"This server's client ID at the provider"`
		ClientSecret string `long:"client-secret" description:"This server's client secret at the provider"`
		BaseURL      string `long:"base-url" description:"This server's public URL, which the client's callback URL starts with"`
	}
	host     *apron.Host
	signIn   *apron.ExternalSignIn
	client   *http.Client
	key      []byte // derives each sign-in's PKCE verifier from its ID
	provider struct {
		Issuer                string `json:"issuer"`
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
		UserinfoEndpoint      string `json:"userinfo_endpoint"`
	}
}

func (*PocketID) Name() string { return "pocketid" }
func (p *PocketID) Flags() any { return &p.Settings }
func (p *PocketID) callback() string {
	return strings.TrimRight(p.Settings.BaseURL, "/") + "/pocketid/callback"
}

func (p *PocketID) Init(r *apron.Registrar) error {
	s := p.Settings
	if s.Issuer == "" || s.ClientID == "" || s.ClientSecret == "" || s.BaseURL == "" {
		return errors.New("set --pocketid.issuer, --pocketid.client-id, --pocketid.client-secret, and --pocketid.base-url")
	}
	p.host, p.client, p.key = r.Host, &http.Client{Timeout: 15 * time.Second}, make([]byte, 32)
	_, _ = rand.Read(p.key)
	request, _ := http.NewRequest(http.MethodGet, strings.TrimRight(s.Issuer, "/")+"/.well-known/openid-configuration", nil)
	if err := p.fetch(request, &p.provider); err != nil {
		return fmt.Errorf("pocketid: discovery: %w", err)
	}
	if p.provider.Issuer != strings.TrimRight(s.Issuer, "/") {
		return fmt.Errorf("pocketid: the provider's issuer is %q", p.provider.Issuer)
	}
	p.signIn = r.ExternalSignIn(p.start)
	r.Handle("GET /pocketid/callback", http.HandlerFunc(p.finish))
	return nil
}

// verifier is the PKCE verifier of the sign-in id, which needs no storage.
func (p *PocketID) verifier(id string) string {
	mac := hmac.New(sha256.New, p.key)
	mac.Write([]byte(id))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// start sends the person to the provider; the sign-in's ID, unguessable and
// single use, is the state.
func (p *PocketID) start(w http.ResponseWriter, r *http.Request, req apron.ExternalRequest) {
	challenge := sha256.Sum256([]byte(p.verifier(req.ID)))
	query := url.Values{
		"response_type": {"code"}, "client_id": {p.Settings.ClientID}, "redirect_uri": {p.callback()},
		"scope": {"openid profile"}, "state": {req.ID},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"},
	}
	http.Redirect(w, r, p.provider.AuthorizationEndpoint+"?"+query.Encode(), http.StatusFound)
}

// finish redeems the provider's code, reads who signed in, and completes the
// sign-in; the server's page then asks them to allow the app.
func (p *PocketID) finish(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("error") == "access_denied" {
		_ = p.signIn.Cancel(w, r, q.Get("state"))
		return
	}
	if q.Get("iss") != "" && q.Get("iss") != p.provider.Issuer { // RFC 9207
		http.Error(w, "Sign-in failed: wrong issuer", http.StatusForbidden)
		return
	}
	identity, err := p.identify(r.Context(), q.Get("code"), q.Get("state"))
	if err != nil {
		p.host.Logger().Warn("Pocket ID sign-in refused", "error", err)
		http.Error(w, "Sign-in failed: "+err.Error(), http.StatusForbidden)
		return
	}
	if err := p.signIn.Complete(w, r, q.Get("state"), identity); err != nil {
		p.host.Logger().Info("sign-in not completed", "error", err)
	}
}

func (p *PocketID) identify(ctx context.Context, code, state string) (apron.Identity, error) {
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {p.callback()},
		"code_verifier": {p.verifier(state)},
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, p.provider.TokenEndpoint, strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.SetBasicAuth(url.QueryEscape(p.Settings.ClientID), url.QueryEscape(p.Settings.ClientSecret))
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := p.fetch(request, &token); err != nil {
		return apron.Identity{}, err
	}
	// The userinfo answer, fetched over TLS with the token just redeemed by
	// this client, names the person; the provider's issuer and sub are theirs
	// for good (§4.12.4).
	request, _ = http.NewRequestWithContext(ctx, http.MethodGet, p.provider.UserinfoEndpoint, nil)
	request.Header.Set("Authorization", "Bearer "+token.AccessToken)
	var user struct {
		Sub               string `json:"sub"`
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := p.fetch(request, &user); err != nil {
		return apron.Identity{}, err
	}
	if user.Sub == "" {
		return apron.Identity{}, errors.New("the provider named no subject")
	}
	return apron.Identity{Subject: p.provider.Issuer + "#" + user.Sub, Name: user.Name, UserID: user.PreferredUsername}, nil
}

func (p *PocketID) fetch(request *http.Request, into any) error {
	request.Header.Set("Accept", "application/json")
	response, err := p.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", request.URL.Path, response.Status)
	}
	return json.NewDecoder(response.Body).Decode(into)
}
