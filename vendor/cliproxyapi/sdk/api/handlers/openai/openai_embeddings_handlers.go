package openai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/MoeForge/moego/ojson"
	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/clienterror"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
)

const (
	openaiEmbeddingsHandlerType = "openai-embedding"
	openaiEmbeddingsPath        = "/v1/embeddings"
	defaultEmbeddingsModel      = "text-embedding-3-small"
)

// Embeddings handles POST /v1/embeddings by routing through a linked Codex account
// to the OpenAI Platform embeddings API (SIWC token or API key on that credential).
func (h *OpenAIAPIHandler) Embeddings(c *gin.Context) {
	rawJSON, err := handlers.ReadRequestBody(c)
	if err != nil {
		c.JSON(clienterror.HTTPStatusFromErrorOr(err, http.StatusBadRequest), handlers.ErrorResponse{
			Error: handlers.ErrorDetail{
				Message: fmt.Sprintf("Invalid request: %v", err),
				Type:    "invalid_request_error",
			},
		})
		return
	}
	if !json.Valid(rawJSON) {
		c.JSON(http.StatusBadRequest, handlers.ErrorResponse{
			Error: handlers.ErrorDetail{
				Message: "Invalid request: body must be valid JSON",
				Type:    "invalid_request_error",
			},
		})
		return
	}

	model := strings.Clone(strings.TrimSpace(ojson.GetBytesNoCopy(rawJSON, "model").String()))
	if model == "" {
		model = defaultEmbeddingsModel
		doc := ojson.NewDoc(rawJSON)
		_ = doc.Set("model", model)
		rawJSON = doc.Bytes()
	}
	if !ojson.GetBytesNoCopy(rawJSON, "input").Exists() {
		c.JSON(http.StatusBadRequest, handlers.ErrorResponse{
			Error: handlers.ErrorDetail{
				Message: "Invalid request: input is required",
				Type:    "invalid_request_error",
			},
		})
		return
	}

	cliCtx, cliCancel := h.GetContextWithCancel(h, c, context.Background())
	defer cliCancel(nil)
	// Rivet workers pin a Codex auth via X-Rivet-Account (filename stem).
	if authID := handlers.NormalizeRivetAccountAuthID(c.GetHeader("X-Rivet-Account")); authID != "" {
		cliCtx = handlers.WithPinnedAuthID(cliCtx, authID)
	}

	resp, errMsg := h.ExecuteProtocolWithAuthManager(cliCtx, handlers.ProtocolExecutionRequest{
		EntryProtocol:  openaiEmbeddingsHandlerType,
		ExitProtocol:   openaiEmbeddingsHandlerType,
		ForcedProvider: "codex",
		Model:          model,
		Body:           rawJSON,
		Path:           openaiEmbeddingsPath,
	})
	if errMsg != nil {
		h.WriteErrorResponse(c, errMsg)
		if errMsg.Error != nil {
			cliCancel(errMsg.Error)
		}
		return
	}

	handlers.WriteUpstreamHeaders(c.Writer.Header(), resp.Headers)
	c.Writer.Header().Set("Content-Type", "application/json")
	_, _ = c.Writer.Write(resp.Body)
}
