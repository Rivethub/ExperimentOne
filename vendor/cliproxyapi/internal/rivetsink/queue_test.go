package rivetsink

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestQueueSenderBatchesEvents(t *testing.T) {
	t.Parallel()
	var (
		mu       sync.Mutex
		batches  []int
		sawEvent atomic.Bool
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/ingest/batch" {
			t.Errorf("path=%s want /v1/ingest/batch", r.URL.Path)
		}
		if got := r.Header.Get("X-Rivet-Ingest-Key"); got != "test-key" {
			t.Errorf("ingest key=%q", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var payload struct {
			Events []json.RawMessage `json:"events"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("unmarshal: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		batches = append(batches, len(payload.Events))
		mu.Unlock()
		if len(payload.Events) > 0 {
			sawEvent.Store(true)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(srv.Close)

	sender := newQueueSender(srv.URL, "test-key")
	for i := 0; i < 5; i++ {
		sender.enqueue([]byte(`{"id":"e","provider":"claude"}`))
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if sawEvent.Load() {
			mu.Lock()
			total := 0
			for _, n := range batches {
				total += n
			}
			mu.Unlock()
			if total >= 5 {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	t.Fatalf("batched events incomplete: batches=%v", batches)
}

func TestQueueSenderFlushesBeforeByteLimit(t *testing.T) {
	t.Parallel()
	var (
		mu      sync.Mutex
		batches []int
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read: %v", err)
			w.WriteHeader(500)
			return
		}
		if len(body) > 2<<20 {
			t.Errorf("batch body %d exceeds Axum 2MiB default", len(body))
		}
		var payload struct {
			Events []json.RawMessage `json:"events"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("unmarshal: %v", err)
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		batches = append(batches, len(payload.Events))
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(srv.Close)

	sender := newQueueSender(srv.URL, "")
	// Three ~400KiB events must split under the 1MiB batch budget.
	fat := bytes.Repeat([]byte("a"), 400<<10)
	event, err := json.Marshal(map[string]string{"id": "e", "blob": string(fat)})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		sender.enqueue(event)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(batches)
		total := 0
		for _, c := range batches {
			total += c
		}
		mu.Unlock()
		if total >= 3 && n >= 2 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	t.Fatalf("expected multiple size-limited batches, got %v", batches)
}

func TestQueueSenderDropsWhenFull(t *testing.T) {
	t.Parallel()
	// Block the worker on the first post so the queue can fill.
	block := make(chan struct{})
	started := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-started:
		default:
			close(started)
		}
		<-block
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(func() {
		close(block)
		srv.Close()
	})

	sender := newQueueSender(srv.URL, "")
	sender.enqueue([]byte(`{"id":"first"}`))
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not start posting")
	}

	for i := 0; i < ingestQueueSize+50; i++ {
		sender.enqueue([]byte(`{"id":"flood"}`))
	}
	if got := sender.dropped.Load(); got == 0 {
		t.Fatal("expected drops under backpressure")
	}
}
