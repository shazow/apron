// Command fakeidp is aprond with an extension that offers external sign-in
// through a fake identity provider page: a form that signs in whoever it names.
package main

import (
	"fmt"
	"html"
	"net/http"
	"net/url"

	"github.com/apron-chat/apron-server-go/apron"
	"github.com/apron-chat/apron-server-go/aproncmd"
)

func main() { aproncmd.Main(&IdP{}) }

type IdP struct{ signIn *apron.ExternalSignIn }

func (*IdP) Name() string { return "fakeidp" }

func (p *IdP) Init(r *apron.Registrar) error {
	p.signIn = r.ExternalSignIn(func(w http.ResponseWriter, req *http.Request, x apron.ExternalRequest) {
		http.Redirect(w, req, "/idp?state="+url.QueryEscape(x.ID)+"&client="+url.QueryEscape(x.Client), http.StatusFound)
	})
	r.Handle("GET /idp", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><title>Fake IdP</title><h1>Fake IdP</h1><p>For %s</p>
<form method="post" action="/idp"><input type="hidden" name="state" value="%s">
<label>Subject <input name="subject" value="idp:ada"></label>
<label>Name <input name="name" value="Ada"></label>
<label>User ID <input name="user_id" value="ada"></label>
<button name="op" value="ok">Sign in at IdP</button><button name="op" value="cancel">Decline at IdP</button></form>`,
			html.EscapeString(q.Get("client")), html.EscapeString(q.Get("state")))
	}))
	r.Handle("POST /idp", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_ = req.ParseForm()
		state := req.PostForm.Get("state")
		if req.PostForm.Get("op") == "cancel" {
			_ = p.signIn.Cancel(w, req, state)
			return
		}
		if err := p.signIn.Complete(w, req, state, apron.Identity{Subject: req.PostForm.Get("subject"), Name: req.PostForm.Get("name"), UserID: req.PostForm.Get("user_id")}); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
		}
	}))
	return nil
}
