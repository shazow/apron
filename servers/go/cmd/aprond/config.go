package main

import (
	"bytes"
	"fmt"
	"io"
	"maps"
	"reflect"
	"slices"
	"strings"

	"github.com/BurntSushi/toml"
	flags "github.com/jessevdk/go-flags"
)

// commandOnly options configure how aprond runs and are not settings.
var commandOnly = map[string]bool{"config": true, "print-config": true}

// loadConfig applies a TOML file's settings to options not given on the
// command line. Top-level keys are flag names; each table is a flag group's
// namespace, so [upload] max-mb = 20 sets --upload.max-mb.
// A list in the file replaces the option's default rather than adding to it.
func loadConfig(parser *flags.Parser, options any, path string) error {
	var values map[string]any
	if _, err := toml.DecodeFile(path, &values); err != nil {
		return err
	}
	fields := make(map[string]reflect.Value)
	optionFields(reflect.ValueOf(options).Elem(), "", parser.NamespaceDelimiter, fields)
	return applyConfig(parser, fields, "", values)
}

// optionFields maps each option's long name, with namespaces, to its field.
func optionFields(v reflect.Value, namespace, delimiter string, fields map[string]reflect.Value) {
	for i := range v.NumField() {
		field, value := v.Type().Field(i), v.Field(i)
		if long := field.Tag.Get("long"); long != "" {
			fields[namespace+long] = value
		} else if field.Type.Kind() == reflect.Struct {
			prefix := namespace
			if ns := field.Tag.Get("namespace"); ns != "" {
				prefix = namespace + ns + delimiter
			}
			optionFields(value, prefix, delimiter, fields)
		}
	}
}

func applyConfig(parser *flags.Parser, fields map[string]reflect.Value, namespace string, values map[string]any) error {
	for _, key := range slices.Sorted(maps.Keys(values)) {
		name := key
		if namespace != "" {
			name = namespace + parser.NamespaceDelimiter + key
		}
		if table, ok := values[key].(map[string]any); ok {
			if err := applyConfig(parser, fields, name, table); err != nil {
				return err
			}
			continue
		}
		option := parser.FindOptionByLongName(name)
		if option == nil || commandOnly[name] {
			return fmt.Errorf("unknown setting %q", name)
		}
		if option.IsSet() && !option.IsSetDefault() {
			continue // The command line takes precedence.
		}
		items, isList := values[key].([]any)
		if !isList {
			items = []any{values[key]}
		}
		if field, ok := fields[name]; ok && field.Kind() == reflect.Slice {
			field.Set(reflect.Zero(field.Type()))
		}
		for _, item := range items {
			text := fmt.Sprint(item)
			if err := option.Set(&text); err != nil {
				return fmt.Errorf("setting %q: %w", name, err)
			}
		}
	}
	return nil
}

// printConfig writes the parser's current settings as a TOML file that
// loadConfig accepts, each preceded by its description.
func printConfig(w io.Writer, parser *flags.Parser) error {
	var buf bytes.Buffer
	var write func(group *flags.Group, table string) error
	write = func(group *flags.Group, table string) error {
		if group.Namespace != "" {
			table = strings.TrimPrefix(table+parser.NamespaceDelimiter+group.Namespace, parser.NamespaceDelimiter)
			fmt.Fprintf(&buf, "\n[%s]\n", table)
		}
		for _, option := range group.Options() {
			if commandOnly[option.LongName] || option.LongName == "" || option.Field().Type.Kind() == reflect.Func {
				continue // Not a setting, such as --help.
			}
			fmt.Fprintf(&buf, "\n# %s\n", option.Description)
			var line bytes.Buffer
			if err := toml.NewEncoder(&line).Encode(map[string]any{option.LongName: option.Value()}); err != nil {
				return err
			}
			if line.Len() == 0 {
				// An empty list has no TOML value of its own; show the key.
				fmt.Fprintf(&line, "# %s = []\n", option.LongName)
			}
			buf.Write(line.Bytes())
		}
		for _, child := range group.Groups() {
			if err := write(child, table); err != nil {
				return err
			}
		}
		return nil
	}
	if err := write(parser.Group, ""); err != nil {
		return err
	}
	_, err := w.Write(bytes.TrimPrefix(buf.Bytes(), []byte("\n")))
	return err
}
