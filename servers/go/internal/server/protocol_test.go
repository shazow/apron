package server

import "testing"

func TestMalformedFrames(t *testing.T) {
	for _, tc := range []struct {
		input string
		code  int
		id    string
	}{
		{`{`, codeParseError, ""},
		{`[]`, codeInvalidRequest, ""},
		{`null`, codeInvalidRequest, ""},
		{`{"method":"message","id":"x","params":[]}`, codeInvalidParams, "x"},
		{`{"method":"message","id":1}`, codeInvalidRequest, ""},
		// Frames are parsed as RFC 7493 I-JSON: a repeated key or invalid
		// UTF-8 is a parse error rather than silently resolved.
		{`{"method":"message","id":"x","method":"history"}`, codeParseError, ""},
		{"{\"method\":\"message\",\"params\":{\"body\":{\"text\":\"\xff\"}}}", codeParseError, ""},
	} {
		t.Run(tc.input, func(t *testing.T) {
			req, err := parseRequest([]byte(tc.input))
			if err == nil || err.Code != tc.code || req.id != tc.id {
				t.Fatalf("parse result = %#v, %#v", req, err)
			}
		})
	}
}
