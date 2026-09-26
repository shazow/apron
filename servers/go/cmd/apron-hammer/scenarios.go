package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const generalRoom = "general"

var httpClient = &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 256}}

// run calls f on n goroutines and waits for them.
func run(n int, f func(i int)) {
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() { f(i) })
	}
	wg.Wait()
}

// connect signs in n guests, at most 32 at a time. notify, when set, makes
// each peer's notification handler.
func connect(h *hammer, n int, label string, options func(i int) dialOptions) []*peer {
	peers := make([]*peer, n)
	slots := make(chan struct{}, 32)
	run(n, func(i int) {
		slots <- struct{}{}
		defer func() { <-slots }()
		var o dialOptions
		if options != nil {
			o = options(i)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		p, err := h.dialGuest(ctx, fmt.Sprintf("%s %d", label, i), o)
		if err != nil {
			fmt.Printf("   !! connect %s %d: %v\n", label, i, err)
			return
		}
		peers[i] = p
	})
	return compact(peers)
}

func compact(peers []*peer) []*peer {
	out := peers[:0]
	for _, p := range peers {
		if p != nil {
			out = append(out, p)
		}
	}
	return out
}

func closeAll(peers []*peer) {
	for _, p := range peers {
		p.close()
	}
}

// measure records f under op unless the measured window ended first, which
// is how every loop stops.
func measure(ctx context.Context, st *stats, op string, f func() error) error {
	start := time.Now()
	err := f()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, errDisconnected) {
		// Loops stop on a closed connection, which the frame counters report.
		return err
	}
	st.observe(op, time.Since(start), err)
	return err
}

func text(n int) string {
	const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor "
	return strings.Repeat(words, n/len(words)+1)[:n]
}

func postMessage(ctx context.Context, p *peer, roomID, body string) (string, error) {
	raw, err := p.call(ctx, "message", map[string]any{"room_id": roomID, "body": map[string]any{"text": body}})
	if err != nil {
		return "", err
	}
	var result struct {
		MessageID string `json:"message_id"`
	}
	err = json.Unmarshal(raw, &result)
	return result.MessageID, err
}

// createRoom creates a room or thread with room_set, which joins its creator.
func createRoom(ctx context.Context, p *peer, params map[string]any) (string, error) {
	raw, err := p.call(ctx, "room_set", params)
	if err != nil {
		return "", err
	}
	var result struct {
		RoomID string `json:"room_id"`
	}
	err = json.Unmarshal(raw, &result)
	return result.RoomID, err
}

// orderCheck verifies that a connection sees each room's log_ids increase
// across every logged kind it checks: messages, reactions, and memberships.
type orderCheck struct {
	h        *hammer
	last     map[string]int64
	messages atomic.Int64
}

func newOrderCheck(h *hammer) *orderCheck {
	return &orderCheck{h: h, last: make(map[string]int64)}
}

// notify runs on the peer's read goroutine.
func (o *orderCheck) notify(method string, frame []byte) {
	if method != "message" && method != "reactions" && method != "membership" {
		return
	}
	var f struct {
		Params struct {
			RoomID string `json:"room_id"`
			LogID  string `json:"log_id"`
		} `json:"params"`
	}
	if err := json.Unmarshal(frame, &f); err != nil {
		o.h.protocolViolation("%s notification: %v", method, err)
		return
	}
	id, err := strconv.ParseInt(f.Params.LogID, 10, 64)
	if err != nil {
		o.h.protocolViolation("%s notification log_id %q", method, f.Params.LogID)
		return
	}
	if id <= o.last[f.Params.RoomID] {
		o.h.protocolViolation("room %s log_id %d after %d", f.Params.RoomID, id, o.last[f.Params.RoomID])
	}
	o.last[f.Params.RoomID] = id
	if method == "message" {
		o.messages.Add(1)
	}
}

func runChurn(h *hammer, st *stats) {
	ctx, cancel := st.window()
	defer cancel()
	defer st.finish()
	run(h.clients, func(i int) {
		for n := 0; ctx.Err() == nil; n++ {
			var p *peer
			err := measure(ctx, st, "connect+auth", func() (err error) {
				p, err = h.dialGuest(ctx, "churn", dialOptions{})
				return err
			})
			if err != nil {
				// The window may end after a successful sign-in.
				if p != nil {
					p.close()
				}
				continue
			}
			// Alternate the close handshake with dropped connections.
			if n%2 == 0 {
				p.closeGracefully()
			} else {
				p.close()
			}
		}
	})
}

func runFlood(h *hammer, st *stats) {
	checks := make([]*orderCheck, h.clients)
	peers := connect(h, h.clients, "flood", func(i int) dialOptions {
		checks[i] = newOrderCheck(h)
		return dialOptions{notify: checks[i].notify}
	})
	defer closeAll(peers)
	body := text(h.bodySize)
	var acked atomic.Int64
	ctx, cancel := st.window()
	run(len(peers), func(i int) {
		for ctx.Err() == nil && peers[i].alive() {
			if measure(ctx, st, "message", func() error {
				_, err := postMessage(ctx, peers[i], generalRoom, body)
				return err
			}) == nil {
				acked.Add(1)
			}
		}
	})
	cancel()
	st.finish()
	// Let deliveries of the last posts arrive before counting.
	time.Sleep(500 * time.Millisecond)
	var received int64
	alive := 0
	for i, p := range peers {
		received += checks[i].messages.Load()
		if p.alive() {
			alive++
		}
	}
	st.note("%d posts acknowledged; each of %d live clients received %.1f%% of them on average",
		acked.Load(), alive, 100*float64(received)/float64(max(1, acked.Load()*int64(len(peers)))))
}

func runActivity(h *hammer, st *stats) {
	peers := connect(h, h.clients, "typist", nil)
	defer closeAll(peers)
	ctx, cancel := st.window()
	defer cancel()
	defer st.finish()
	run(len(peers), func(i int) {
		for ctx.Err() == nil && peers[i].alive() {
			_ = measure(ctx, st, "activity", func() error {
				_, err := peers[i].call(ctx, "activity", map[string]any{"room_id": generalRoom, "typing": 1})
				return err
			})
		}
	})
}

// runSlow checks that clients which stop reading are dropped once their
// queue fills, without slowing everyone else down.
func runSlow(h *hammer, st *stats) {
	n := max(1, h.clients/2)
	senders := connect(h, n, "sender", nil)
	defer closeAll(senders)
	slow := connect(h, n, "slow", func(int) dialOptions { return dialOptions{noRead: true} })
	defer closeAll(slow)
	body := text(4 << 10)
	ctx, cancel := st.window()
	run(len(senders), func(i int) {
		for ctx.Err() == nil && senders[i].alive() {
			_ = measure(ctx, st, "message 4KiB", func() error {
				_, err := postMessage(ctx, senders[i], generalRoom, body)
				return err
			})
		}
	})
	cancel()
	st.finish()
	// A slow client the server dropped reads to the end of what was sent and
	// then sees the connection close; one still held open just times out.
	var dropped, held atomic.Int64
	run(len(slow), func(i int) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		for {
			if _, _, err := slow[i].ws.Read(ctx); err != nil {
				if errors.Is(err, context.DeadlineExceeded) {
					held.Add(1)
				} else {
					dropped.Add(1)
				}
				return
			}
		}
	})
	st.note("slow clients: %d dropped by the server, %d still connected", dropped.Load(), held.Load())
}

const historySeed = 20000

func runHistory(h *hammer, st *stats) {
	setup, cancelSetup := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancelSetup()
	writer := connect(h, 1, "historian", nil)
	if len(writer) == 0 {
		return
	}
	defer closeAll(writer)
	roomID, err := createRoom(setup, writer[0], map[string]any{"title": "History bench"})
	if err != nil {
		st.note("create room: %v", err)
		return
	}
	started := time.Now()
	ids := make([]int64, historySeed)
	var next atomic.Int64
	body := text(h.bodySize)
	run(32, func(int) {
		for i := int(next.Add(1) - 1); i < historySeed; i = int(next.Add(1) - 1) {
			id, err := postMessage(setup, writer[0], roomID, body)
			if err != nil {
				return
			}
			ids[i], _ = strconv.ParseInt(id, 10, 64)
		}
	})
	st.note("seeded %d messages in %s", historySeed, time.Since(started).Round(time.Millisecond))

	readers := connect(h, h.clients, "reader", nil)
	defer closeAll(readers)
	ctx, cancel := st.window()
	defer cancel()
	defer st.finish()
	run(len(readers), func(i int) {
		random := rand.New(rand.NewPCG(uint64(i), 1))
		for ctx.Err() == nil && readers[i].alive() {
			if random.IntN(2) == 0 {
				_ = measure(ctx, st, "history latest 100", func() error {
					_, err := readers[i].call(ctx, "history", map[string]any{"room_id": roomID, "limit": 100})
					return err
				})
				continue
			}
			before := strconv.FormatInt(ids[random.IntN(len(ids))], 10)
			_ = measure(ctx, st, "history page 1000", func() error {
				_, err := readers[i].call(ctx, "history", map[string]any{"room_id": roomID, "before": before, "limit": 1000})
				return err
			})
		}
	})
}

const threadCount = 1000

func runThreads(h *hammer, st *stats) {
	setup, cancelSetup := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancelSetup()
	creator := connect(h, 1, "weaver", nil)
	if len(creator) == 0 {
		return
	}
	defer closeAll(creator)
	started := time.Now()
	var next atomic.Int64
	threads := make([]string, threadCount)
	run(16, func(int) {
		for i := next.Add(1); i <= threadCount; i = next.Add(1) {
			id, err := createRoom(setup, creator[0], map[string]any{"parent_room_id": generalRoom, "title": fmt.Sprintf("Thread %d", i)})
			if err != nil {
				return
			}
			threads[i-1] = id
		}
	})
	threads = slices.DeleteFunc(threads, func(id string) bool { return id == "" })
	if len(threads) == 0 {
		st.note("created no threads")
		return
	}
	st.note("created %d threads in %s", len(threads), time.Since(started).Round(time.Millisecond))

	listers := connect(h, max(1, h.clients/2), "lister", nil)
	defer closeAll(listers)
	ctx, cancel := st.window()
	defer cancel()
	defer st.finish()
	run(h.clients, func(i int) {
		for n := 0; ctx.Err() == nil; n++ {
			if i < len(listers) {
				// Alternate the threads a client could join with the joined
				// rooms and their members.
				if n%2 == 0 {
					_ = measure(ctx, st, "room_list not_joined", func() error {
						_, err := listers[i].call(ctx, "room_list", map[string]any{"parent_room_id": generalRoom, "filter": "not_joined"})
						return err
					})
				} else {
					_ = measure(ctx, st, "room_list members", func() error {
						_, err := listers[i].call(ctx, "room_list", map[string]any{"filter": "joined", "members": true})
						return err
					})
				}
				continue
			}
			// A client signs in and lists its joined rooms with their
			// members in one round trip, then joins and leaves a thread;
			// each join and leave is a logged membership.
			var p *peer
			if measure(ctx, st, "auth+room_list", func() (err error) {
				p, err = h.dialGuest(ctx, "joiner", dialOptions{list: true})
				return err
			}) != nil {
				// The window may end after a successful sign-in.
				if p != nil {
					p.close()
				}
				continue
			}
			thread := threads[(i+n)%len(threads)]
			_ = measure(ctx, st, "room_join", func() error {
				_, err := p.call(ctx, "room_join", map[string]any{"room_id": thread})
				return err
			})
			_ = measure(ctx, st, "room_leave", func() error {
				_, err := p.call(ctx, "room_leave", map[string]any{"room_id": thread})
				return err
			})
			p.close()
		}
	})
}

func runEdits(h *hammer, st *stats) {
	peers := connect(h, h.clients, "editor", nil)
	defer closeAll(peers)
	ctx, cancel := st.window()
	defer cancel()
	defer st.finish()
	run(len(peers), func(i int) {
		p := peers[i]
		for ctx.Err() == nil && p.alive() {
			var id string
			if measure(ctx, st, "post", func() (err error) {
				id, err = postMessage(ctx, p, generalRoom, "draft")
				return err
			}) != nil {
				continue
			}
			for edit := range 3 {
				_ = measure(ctx, st, "edit", func() error {
					_, err := p.call(ctx, "message", map[string]any{"room_id": generalRoom, "message_id": id, "body": map[string]any{"text": fmt.Sprintf("edit %d", edit)}})
					return err
				})
			}
			for _, emojis := range [][]string{{"👍", "🎉"}, {}} {
				_ = measure(ctx, st, "reactions", func() error {
					_, err := p.call(ctx, "reactions", map[string]any{"message_id": id, "emojis": emojis})
					return err
				})
			}
			_ = measure(ctx, st, "delete", func() error {
				_, err := p.call(ctx, "message", map[string]any{"room_id": generalRoom, "message_id": id, "deleted": true})
				return err
			})
		}
	})
}

const uploadBytes = 64 << 10

func runEmbeds(h *hammer, st *stats) {
	streamers := max(1, h.clients/4)
	messages := make([]chan []byte, streamers)
	peers := connect(h, h.clients, "sharer", func(i int) dialOptions {
		if i >= streamers {
			return dialOptions{}
		}
		// Streamers learn their stream URL from the message broadcast.
		ch := make(chan []byte, 1024)
		messages[i] = ch
		return dialOptions{notify: func(method string, frame []byte) {
			if method == "message" {
				select {
				case ch <- frame:
				default:
				}
			}
		}}
	})
	defer closeAll(peers)
	// Idle keep-alive connections would otherwise count as server goroutines.
	defer httpClient.CloseIdleConnections()
	payload := bytes.Repeat([]byte{0xA5}, uploadBytes)
	ctx, cancel := st.window()
	defer cancel()
	defer st.finish()
	run(len(peers), func(i int) {
		for ctx.Err() == nil && peers[i].alive() {
			if i < streamers && messages[i] != nil {
				_ = measure(ctx, st, "stream 2s", func() error { return stream(ctx, peers[i], messages[i]) })
			} else {
				_ = measure(ctx, st, "upload+get 64KiB", func() error { return upload(ctx, peers[i], payload) })
			}
		}
	})
}

type writtenEmbed struct {
	Embeds []struct {
		WriteURL string `json:"write_url"`
	} `json:"embeds"`
	MessageID string `json:"message_id"`
}

func postEmbed(ctx context.Context, p *peer, kind string) (writtenEmbed, error) {
	var result writtenEmbed
	raw, err := p.call(ctx, "message", map[string]any{"room_id": generalRoom, "body": map[string]any{
		"text": kind, "embeds": []any{map[string]any{"kind": kind, "title": kind + ".bin"}},
	}})
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return result, err
	}
	if len(result.Embeds) != 1 {
		return result, fmt.Errorf("message result has %d write URLs", len(result.Embeds))
	}
	return result, nil
}

func upload(ctx context.Context, p *peer, payload []byte) error {
	written, err := postEmbed(ctx, p, "upload")
	if err != nil {
		return err
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodPut, written.Embeds[0].WriteURL, bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/octet-stream")
	response, err := httpClient.Do(request)
	if err != nil {
		return err
	}
	var put struct {
		URL string `json:"url"`
	}
	err = json.NewDecoder(response.Body).Decode(&put)
	response.Body.Close()
	if response.StatusCode != http.StatusCreated || err != nil {
		return fmt.Errorf("PUT: %s", response.Status)
	}
	request, _ = http.NewRequestWithContext(ctx, http.MethodGet, put.URL, nil)
	response, err = httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	got, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if !bytes.Equal(got, payload) {
		return fmt.Errorf("GET returned %d bytes, want %d", len(got), len(payload))
	}
	return nil
}

// stream writes 1 KiB chunks to a stream for two seconds while reading it
// back from its stream URL.
func stream(ctx context.Context, p *peer, messages chan []byte) error {
	// Discard broadcasts that arrived since the last stream.
	for len(messages) > 0 {
		<-messages
	}
	written, err := postEmbed(ctx, p, "stream")
	if err != nil {
		return err
	}
	streamURL, err := awaitStreamURL(ctx, messages, written.MessageID)
	if err != nil {
		return err
	}
	body, writer := io.Pipe()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, written.Embeds[0].WriteURL, body)
	request.Header.Set("Content-Type", "text/plain")
	posted := make(chan error, 1)
	go func() {
		response, err := httpClient.Do(request)
		if err == nil {
			response.Body.Close()
			if response.StatusCode != http.StatusNoContent {
				err = fmt.Errorf("stream POST: %s", response.Status)
			}
		}
		posted <- err
	}()
	chunk := []byte(text(1 << 10))
	sent := 0
	var readErr error
	var got int64
	readDone := make(chan struct{})
	readStart := time.Now()
	var readTook time.Duration
	go func() {
		defer close(readDone)
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, streamURL, nil)
		response, err := httpClient.Do(request)
		if err != nil {
			readErr = err
			return
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			readErr = fmt.Errorf("stream GET: %s", response.Status)
			return
		}
		got, readErr = io.Copy(io.Discard, response.Body)
		readTook = time.Since(readStart)
	}()
	for end := time.Now().Add(2 * time.Second); time.Now().Before(end) && ctx.Err() == nil; {
		if _, err := writer.Write(chunk); err != nil {
			break
		}
		sent += len(chunk)
		time.Sleep(10 * time.Millisecond)
	}
	writer.Close()
	if err := <-posted; err != nil {
		return err
	}
	<-readDone
	if readErr != nil {
		return readErr
	}
	if got == 0 {
		return fmt.Errorf("stream reader got nothing of %d bytes; its response ended after %s", sent, readTook.Round(time.Millisecond))
	}
	return nil
}

func awaitStreamURL(ctx context.Context, messages chan []byte, messageID string) (string, error) {
	timeout := time.After(5 * time.Second)
	for {
		select {
		case frame := <-messages:
			var f struct {
				Params struct {
					MessageID string `json:"message_id"`
					Body      struct {
						Embeds []struct {
							URL string `json:"url"`
						} `json:"embeds"`
					} `json:"body"`
				} `json:"params"`
			}
			if json.Unmarshal(frame, &f) == nil && f.Params.MessageID == messageID && len(f.Params.Body.Embeds) == 1 {
				return f.Params.Body.Embeds[0].URL, nil
			}
		case <-timeout:
			return "", errors.New("no broadcast carried the stream URL")
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}
