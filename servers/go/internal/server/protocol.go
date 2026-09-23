package server

import (
	"bytes"
	"encoding/json"
	"fmt"
)

const (
	codeParseError     = -32700
	codeInvalidRequest = -32600
	codeUnsupported    = -32601
	codeInvalidParams  = -32602
	codeInternalError  = -32603
	codeDenied         = -32001
	codeRetryAfter     = -32002
	codeTooLarge       = -32003
)

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type rpcResponse struct {
	JSONRPC string    `json:"jsonrpc,omitempty"`
	ID      any       `json:"id,omitempty"`
	Result  any       `json:"result,omitempty"`
	Error   *rpcError `json:"error,omitempty"`
}

type request struct {
	method string
	params map[string]json.RawMessage
	id     string
	hasID  bool
	full   bool
}

func parseRequest(payload []byte) (request, *rpcError) {
	if !json.Valid(payload) {
		return request{}, &rpcError{Code: codeParseError, Message: "Parse error"}
	}

	var object map[string]json.RawMessage
	if err := json.Unmarshal(payload, &object); err != nil || object == nil {
		return request{}, &rpcError{Code: codeInvalidRequest, Message: "Invalid request"}
	}

	var req request
	if rawID, ok := object["id"]; ok {
		req.hasID = true
		if bytes.Equal(bytes.TrimSpace(rawID), []byte("null")) || json.Unmarshal(rawID, &req.id) != nil {
			req.hasID = false
			return req, &rpcError{Code: codeInvalidRequest, Message: "Request id must be a string"}
		}
	}

	if raw, ok := object["jsonrpc"]; ok {
		var version string
		if err := json.Unmarshal(raw, &version); err != nil || version != "2.0" {
			return req, &rpcError{Code: codeInvalidRequest, Message: "Invalid JSON-RPC version"}
		}
		req.full = true
	}

	rawMethod, ok := object["method"]
	if !ok || json.Unmarshal(rawMethod, &req.method) != nil || req.method == "" {
		return req, &rpcError{Code: codeInvalidRequest, Message: "Invalid request"}
	}

	req.params = make(map[string]json.RawMessage)
	if rawParams, ok := object["params"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawParams), []byte("null")) || json.Unmarshal(rawParams, &req.params) != nil || req.params == nil {
			return req, invalidParams("Params must be an object")
		}
	}
	return req, nil
}

func canonicalParams(params map[string]json.RawMessage) string {
	if params == nil {
		return "{}"
	}
	var value any
	raw, err := json.Marshal(params)
	if err != nil || json.Unmarshal(raw, &value) != nil {
		return string(raw)
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return string(raw)
	}
	return string(canonical)
}

func requestFingerprint(req request) string {
	return req.method + "\x00" + canonicalParams(req.params)
}

func response(id string, full bool, result any) rpcResponse {
	r := rpcResponse{ID: id, Result: result}
	if full {
		r.JSONRPC = "2.0"
	}
	return r
}

// errorResponse builds an error reply. A nil id omits "id", as for errors not
// tied to a request (PROTOCOL.md §1.1).
func errorResponse(id any, full bool, e *rpcError) rpcResponse {
	r := rpcResponse{ID: id, Error: e}
	if full {
		r.JSONRPC = "2.0"
	}
	return r
}

func invalidParams(format string, args ...any) *rpcError {
	return &rpcError{Code: codeInvalidParams, Message: fmt.Sprintf(format, args...)}
}

func parseString(params map[string]json.RawMessage, name string, required bool) (string, *rpcError) {
	raw, ok := params[name]
	if !ok {
		if required {
			return "", invalidParams("Missing %s", name)
		}
		return "", nil
	}
	var value string
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil {
		return "", invalidParams("%s must be a string", name)
	}
	return value, nil
}

func parseBool(params map[string]json.RawMessage, name string, required bool) (bool, *rpcError) {
	raw, ok := params[name]
	if !ok {
		if required {
			return false, invalidParams("Missing %s", name)
		}
		return false, nil
	}
	var value bool
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil {
		return false, invalidParams("%s must be a boolean", name)
	}
	return value, nil
}

func parseObject(params map[string]json.RawMessage, name string, required bool) (map[string]any, *rpcError) {
	raw, ok := params[name]
	if !ok {
		if required {
			return nil, invalidParams("Missing %s", name)
		}
		return nil, nil
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, invalidParams("%s must be an object", name)
	}
	return value, nil
}

func cloneValue(value any) any {
	switch value := value.(type) {
	case map[string]any:
		copyValue := make(map[string]any, len(value))
		for key, child := range value {
			copyValue[key] = cloneValue(child)
		}
		return copyValue
	case []any:
		copyValue := make([]any, len(value))
		for i, child := range value {
			copyValue[i] = cloneValue(child)
		}
		return copyValue
	default:
		return value
	}
}

func cloneObject(value map[string]any) map[string]any {
	if value == nil {
		return nil
	}
	return cloneValue(value).(map[string]any)
}
