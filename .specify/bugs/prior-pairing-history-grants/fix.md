# Fix: prior pairing history grants

For a grant addressed to the same browser device, compare its trust sequence with the currently pinned certificate before trying to install it. A strictly older sequence returns `Prior pairing history grant ignored` and installs no key. `runKeySync` treats this as a skippable record while continuing the same page. Equal/newer sequences still follow the existing origin, transcript, public-key, signature, and HPKE checks.

No server ciphertext, grant, or trust statement is removed or changed. The browser cursor can advance only after the current page's remaining results are accepted.
