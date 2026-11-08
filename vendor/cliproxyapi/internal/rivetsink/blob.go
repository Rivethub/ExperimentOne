package rivetsink

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	previewReqBytes  = 24 * 1024
	previewRespBytes = 24 * 1024
)

// buildPreview keeps a short head of the request and head+tail of the response
// for ClickHouse/list UI. Full bodies live under body_ref when spilled.
func buildPreview(reqBody, respBody []byte) string {
	reqPart := truncate(string(reqBody), previewReqBytes)
	if len(reqBody) > previewReqBytes {
		reqPart += "\n…[truncated]"
	}
	if len(respBody) == 0 {
		return reqPart
	}
	respPart := string(respBody)
	if len(respPart) > previewRespBytes {
		half := previewRespBytes / 2
		if half < 1 {
			half = previewRespBytes
		}
		respPart = respPart[:half] + "\n…\n" + respPart[len(respPart)-half:]
	}
	if reqPart == "" {
		return respPart
	}
	return reqPart + "\n---\n" + respPart
}

func (w *Wrapper) spillBody(eventID, full string) (rel string, ok bool) {
	dir := strings.TrimSpace(w.blobsDir)
	if dir == "" || full == "" {
		return "", false
	}
	now := time.Now().UTC()
	rel = filepath.ToSlash(filepath.Join(
		"traffic",
		fmt.Sprintf("%04d", now.Year()),
		fmt.Sprintf("%02d", int(now.Month())),
		fmt.Sprintf("%02d", now.Day()),
		eventID+".txt",
	))
	abs := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", false
	}
	if err := os.WriteFile(abs, []byte(full), 0o644); err != nil {
		return "", false
	}
	return rel, true
}

func (w *Wrapper) openSpill(eventID string) (file *os.File, rel, abs string, err error) {
	dir := strings.TrimSpace(w.blobsDir)
	if dir == "" {
		return nil, "", "", nil
	}
	if eventID == "" {
		eventID = uuid.NewString()
	}
	now := time.Now().UTC()
	rel = filepath.ToSlash(filepath.Join(
		"traffic",
		fmt.Sprintf("%04d", now.Year()),
		fmt.Sprintf("%02d", int(now.Month())),
		fmt.Sprintf("%02d", now.Day()),
		eventID+".txt",
	))
	abs = filepath.Join(dir, filepath.FromSlash(rel))
	if mkdirErr := os.MkdirAll(filepath.Dir(abs), 0o755); mkdirErr != nil {
		return nil, "", "", mkdirErr
	}
	file, err = os.OpenFile(abs, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, "", "", err
	}
	return file, rel, abs, nil
}

// mergeWebsocketIntoResponse folds client/upstream websocket timelines into the
// captured response body so Codex Responses WS turns are not dropped.
func mergeWebsocketIntoResponse(response, websocketTimeline, apiWebsocketTimeline []byte) []byte {
	ws := apiWebsocketTimeline
	if len(ws) == 0 {
		ws = websocketTimeline
	} else if len(websocketTimeline) > 0 && !bytes.Equal(ws, websocketTimeline) {
		combined := append([]byte(nil), websocketTimeline...)
		combined = append(combined, []byte("\n=== API WEBSOCKET TIMELINE ===\n")...)
		combined = append(combined, apiWebsocketTimeline...)
		ws = combined
	}
	if len(ws) == 0 {
		return response
	}
	if len(response) == 0 {
		return append([]byte(nil), ws...)
	}
	out := append([]byte(nil), response...)
	out = append(out, []byte("\n=== WEBSOCKET TIMELINE ===\n")...)
	out = append(out, ws...)
	return out
}

func finalizeSpill(abs string) (redacted string, err error) {
	raw, err := os.ReadFile(abs)
	if err != nil {
		return "", err
	}
	redacted = redactSecrets(string(raw))
	if redacted != string(raw) {
		if writeErr := os.WriteFile(abs, []byte(redacted), 0o644); writeErr != nil {
			return redacted, writeErr
		}
	}
	return redacted, nil
}
