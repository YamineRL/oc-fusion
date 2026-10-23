# Overrides fish's built-in oc.fish (OpenShift's `oc completion fish`).
# Here `oc` is the Fusion opencode wrapper, so complete it like opencode.
# opencode cuts its output at 64 KiB when stdout is a pipe, so write a file.
set -l tmp (mktemp)
opencode --completions fish >$tmp 2>/dev/null
and string replace -r -- '^complete -c opencode\b' 'complete -c oc' <$tmp | source
rm -f $tmp
