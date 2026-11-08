package rivetsink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	log "github.com/sirupsen/logrus"
)

const (
	ingestQueueSize     = 256
	ingestBatchMax      = 32
	ingestBatchMaxBytes = 1 << 20
	ingestBatchWait     = 50 * time.Millisecond
	ingestMaxAttempts   = 3
	spoolReplayMax      = 50
)

// queueSender batches marshaled traffic events onto /v1/ingest/batch with
// bounded memory. Full queue or failed posts → disk spool (never block the
// proxy request path).
type queueSender struct {
	endpoint  string
	ingestKey string
	spoolDir  string
	client    *http.Client
	queue     chan json.RawMessage
	dropped   atomic.Uint64
	spooled   atomic.Uint64
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
	spoolDir := strings.TrimSpace(os.Getenv("RIVET_INGEST_SPOOL_DIR"))
	if spoolDir == "" {
		if data := strings.TrimSpace(os.Getenv("RIVET_DATA_DIR")); data != "" {
			spoolDir = filepath.Join(data, "spool", "ingest")
		}
	}
	s := &queueSender{
		endpoint:  strings.TrimRight(ingestURL, "/") + "/v1/ingest/batch",
		ingestKey: ingestKey,
		spoolDir:  spoolDir,
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
		if s.spoolPayload(msg) {
			n := s.spooled.Add(1)
			if n == 1 || n%100 == 0 {
				log.Warnf("rivet sink queue full; spooled %d event(s) to disk", n)
			}
			return
		}
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
	replayTicker := time.NewTicker(2 * time.Second)
	defer replayTicker.Stop()

	flush := func() {
		if len(batch) == 0 {
			return
		}
		s.postBatch(batch)
		batch = batch[:0]
		batchBytes = 0
	}

	appendMsg := func(msg json.RawMessage) {
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
			select {
			case msg, ok := <-s.queue:
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
			case <-replayTicker.C:
				s.replaySpool()
			}
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
		case <-replayTicker.C:
			// Prefer flushing the live batch first; spool replay waits for idle.
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

	for _, msg := range batch {
		_ = s.spoolPayload(msg)
	}
}

func (s *queueSender) spoolPayload(msg json.RawMessage) bool {
	if s.spoolDir == "" || len(msg) == 0 {
		return false
	}
	if err := os.MkdirAll(s.spoolDir, 0o755); err != nil {
		return false
	}
	name := fmt.Sprintf("%d-%d.json", time.Now().UnixNano(), s.spooled.Load()+1)
	path := filepath.Join(s.spoolDir, name)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, msg, 0o600); err != nil {
		return false
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return false
	}
	return true
}

func (s *queueSender) replaySpool() {
	if s.spoolDir == "" {
		return
	}
	entries, err := os.ReadDir(s.spoolDir)
	if err != nil {
		return
	}
	n := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(s.spoolDir, entry.Name())
		raw, err := os.ReadFile(path)
		if err != nil || len(raw) == 0 {
			continue
		}
		batch := []json.RawMessage{json.RawMessage(raw)}
		if !s.postBatchOnce(batch) {
			return
		}
		_ = os.Remove(path)
		n++
		if n >= spoolReplayMax {
			return
		}
	}
}

func (s *queueSender) postBatchOnce(batch []json.RawMessage) bool {
	body, err := json.Marshal(struct {
		Events []json.RawMessage `json:"events"`
	}{Events: batch})
	if err != nil {
		return false
	}
	ingestKey := s.ingestKey
	if ingestKey == "" {
		ingestKey = strings.TrimSpace(os.Getenv("RIVET_INGEST_KEY"))
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, s.endpoint, bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	if ingestKey != "" {
		req.Header.Set("X-Rivet-Ingest-Key", ingestKey)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return false
	}
	code := resp.StatusCode
	_ = resp.Body.Close()
	return code >= 200 && code < 300
}
