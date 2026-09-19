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
		{`{"method":"send","id":"x","params":[]}`, codeInvalidParams, "x"},
		{`{"method":"send","id":1}`, codeInvalidRequest, ""},
	} {
		t.Run(tc.input, func(t *testing.T) {
			req, err := parseRequest([]byte(tc.input))
			if err == nil || err.Code != tc.code || req.id != tc.id {
				t.Fatalf("parse result = %#v, %#v", req, err)
			}
		})
	}
}
