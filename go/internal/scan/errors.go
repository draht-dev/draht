package scan

import "errors"

// ErrNotImplemented marks scaffold stubs awaiting their real implementation.
// WP-A replaces every call site that returns this with the real logic.
var ErrNotImplemented = errors.New("scan: not implemented (scaffold stub)")
