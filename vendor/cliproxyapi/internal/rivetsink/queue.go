package rivetsink

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	log "github.com/sirupsen/logrus"
)

const (
	ingestQueueSize = 256
	ingestBatchMax  = 32
	// Keep serialized batches under Axum's default 2 MiB JSON body limit.
	ingestBatchMaxBytes = 1 << 20
	ingestBatchWait     = 50 * time.Millisecond
	ingestMaxAttempts   = 3
)

// queueSender batches marshaled traffic events onto /v1/ingest/batch with
// bounded memory. Full queue → drop (never block the proxy request path).
type queueSender struct {
	endpoint  string
	ingestKey string
	client    *http.Client
	queue     chan json.RawMessage
	dropped   atomic.Uint64
}

func newQueueSender(ingestURL, ingestKey string) *queueSender {
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   500 * time.Millisecond,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          8,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   2 * time.Second,
		ExpectContinueTimeout: 500 * time.Millisecond,
	}
	s := &queueSender{
		endpoint:  strings.TrimRight(ingestURL, "/") + "/v1/ingest/batch",
		ingestKey: ingestKey,
		client: &http.Client{
			Timeout:   3 * time.Second,
			Transport: transport,
		},
		queue: make(chan json.RawMessage, ingestQueueSize),
	}
	go s.loop()
	return s
}

func (s *queueSender) enqueue(payload []byte) {
	if len(payload) == 0 {
		return
	}
	msg := json.RawMessage(append([]byte(nil), payload...))
	select {
	case s.queue <- msg:
	default:
		n := s.dropped.Add(1)
		if n == 1 || n%100 == 0 {
			log.Warnf("rivet sink queue full; dropped %d event(s)", n)
		}
	}
}

func (s *queueSender) loop() {
	batch := make([]json.RawMessage, 0, ingestBatchMax)
	batchBytes := 0
	timer := time.NewTimer(ingestBatchWait)
	defer timer.Stop()

	flush := func() {
		if len(batch) == 0 {
			return
		}
		s.postBatch(batch)
		batch = batch[:0]
		batchBytes = 0
	}

	appendMsg := func(msg json.RawMessage) {
		// JSON array overhead: opening, commas, closing — keep a small pad in the budget.
		next := batchBytes + len(msg) + 2
		if len(batch) > 0 && (len(batch) >= ingestBatchMax || next > ingestBatchMaxBytes) {
			flush()
		}
		batch = append(batch, msg)
		batchBytes += len(msg) + 2
		if len(batch) >= ingestBatchMax || batchBytes >= ingestBatchMaxBytes {
			flush()
		}
	}

	for {
		if len(batch) == 0 {
			msg, ok := <-s.queue
			if !ok {
				return
			}
			appendMsg(msg)
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(ingestBatchWait)
			continue
		}

		select {
		case msg, ok := <-s.queue:
			if !ok {
				flush()
				return
			}
			appendMsg(msg)
		case <-timer.C:
			flush()
		}
	}
}

func (s *queueSender) postBatch(batch []json.RawMessage) {
	body, err := json.Marshal(struct {
		Events []json.RawMessage `json:"events"`
	}{Events: batch})
	if err != nil {
		return
	}

	ingestKey := s.ingestKey
	if ingestKey == "" {
		ingestKey = strings.TrimSpace(os.Getenv("RIVET_INGEST_KEY"))
	}

	for attempt := 0; attempt < ingestMaxAttempts; attempt++ {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, s.endpoint, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		if ingestKey != "" {
			req.Header.Set("X-Rivet-Ingest-Key", ingestKey)
		}
		resp, err := s.client.Do(req)
		if err != nil {
			log.Warnf("rivet sink batch attempt %d: %v", attempt+1, err)
			time.Sleep(time.Duration(attempt+1) * 200 * time.Millisecond)
			continue
		}
		code := resp.StatusCode
		_ = resp.Body.Close()
		if code >= 200 && code < 300 {
			return
		}
		log.Warnf("rivet sink batch attempt %d: HTTP %d (check RIVET_INGEST_KEY matches rivetd)", attempt+1, code)
		time.Sleep(time.Duration(attempt+1) * 200 * time.Millisecond)
	}
}
