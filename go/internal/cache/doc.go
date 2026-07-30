// Package cache is a byte-oriented, content-hash-keyed on-disk store for
// per-file extraction payloads. It imports nothing but stdlib — the codec
// for the payload bytes lives in package extract — so cache and extract can
// be developed independently.
package cache
