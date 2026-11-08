package rivetsink

import (
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/logging"
)

type stubLogger struct {
	enabled bool
	forced  bool
}

func (s *stubLogger) LogRequest(string, string, map[string][]string, []byte, int, map[string][]string, []byte, []byte, []byte, []byte, []byte, []*interfaces.ErrorMessage, string, time.Time, time.Time) error {
	return nil
}

func (s *stubLogger) LogRequestWithOptions(_ string, _ string, _ map[string][]string, _ []byte, _ int, _ map[string][]string, _ []byte, _ []byte, _ []byte, _ []byte, _ []byte, _ []*interfaces.ErrorMessage, force bool, _ string, _ time.Time, _ time.Time) error {
	s.forced = force
	return nil
}

func (s *stubLogger) LogStreamingRequest(string, string, map[string][]string, []byte, string) (logging.StreamingLogWriter, error) {
	return &logging.NoOpStreamingLogWriter{}, nil
}

func (s *stubLogger) IsEnabled() bool { return s.enabled }

func (s *stubLogger) SetEnabled(enabled bool) { s.enabled = enabled }

func TestWrapperIsEnabledIndependentOfFileLogger(t *testing.T) {
	t.Parallel()
	inner := &stubLogger{enabled: false}
	w := &Wrapper{inner: inner, sender: newQueueSender("http://127.0.0.1:9", "")}
	if !w.IsEnabled() {
		t.Fatal("Wrapper.IsEnabled want true while ingest configured")
	}
	w.SetEnabled(false)
	if inner.enabled {
		t.Fatal("SetEnabled should toggle inner file logger only")
	}
	if !w.IsEnabled() {
		t.Fatal("Wrapper.IsEnabled must stay true for Rivet capture")
	}
}

func TestWrapperForwardsForceFlag(t *testing.T) {
	t.Parallel()
	inner := &stubLogger{enabled: false}
	w := &Wrapper{inner: inner, sender: newQueueSender("http://127.0.0.1:9", "")}
	err := w.LogRequestWithOptions(
		"/v1/messages", "POST", nil, []byte(`{}`), 500, nil, []byte(`{}`),
		nil, nil, nil, nil, nil, true, "req", time.Now(), time.Now(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !inner.forced {
		t.Fatal("expected force=true passed to inner logger")
	}
}

func TestWrapperForcesErrorLogWhenRequestLogDisabled(t *testing.T) {
	t.Parallel()
	inner := &stubLogger{enabled: false}
	w := &Wrapper{inner: inner, sender: newQueueSender("http://127.0.0.1:9", "")}
	// Middleware keeps force=false because Wrapper.IsEnabled is true.
	err := w.LogRequestWithOptions(
		"/v1/messages", "POST", nil, []byte(`{}`), 502, nil, []byte(`{"error":"x"}`),
		nil, nil, nil, nil, nil, false, "req", time.Now(), time.Now(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !inner.forced {
		t.Fatal("expected wrapper to force error file log when inner request-log is off")
	}
}

func TestWrapperForcesStreamingErrorLog(t *testing.T) {
	t.Parallel()
	inner := &stubLogger{enabled: false}
	w := &Wrapper{inner: inner, sender: newQueueSender("http://127.0.0.1:9", "")}
	writer, err := w.LogStreamingRequest("/v1/messages", "POST", nil, []byte(`{}`), "req")
	if err != nil {
		t.Fatal(err)
	}
	_ = writer.WriteStatus(500, nil)
	_ = writer.WriteAPIRequest([]byte("=== API REQUEST 1 ===\nUpstream URL: https://aiplatform.googleapis.com/v1/x\nAuth: provider=vertex, auth_id=v1\n"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if !inner.forced {
		t.Fatal("expected streaming error to force inner file log")
	}
}

func TestMergeAPIRequestCaptureReadsSource(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	src, err := logging.NewFileBodySourceInDir(dir, "api-request")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = src.Cleanup() })
	payload := []byte("=== API REQUEST 1 ===\nUpstream URL: https://aiplatform.googleapis.com/v1/x\nAuth: provider=vertex, auth_id=v1\n\nBody:\n{}\n")
	if err := src.AppendBytes(payload); err != nil {
		t.Fatal(err)
	}
	got := mergeAPIRequestCapture(nil, src)
	if inferProviderFromCapture("/v1/messages", []byte(`{"model":"claude-sonnet-4-5"}`), got) != "vertex" {
		t.Fatalf("provider from source-backed capture = %q want vertex", inferProviderFromCapture("/v1/messages", []byte(`{"model":"claude-sonnet-4-5"}`), got))
	}
}
