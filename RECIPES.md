# Apron Recipes

Recipes show how to build common things on Apron without changing the
protocol. Each recipe answers "Can Apron do X?" with an outline that stays
within [PROTOCOL.md](PROTOCOL.md) and the [extensions](EXTENSIONS.md).

- Recipes are informative. Where a recipe and PROTOCOL.md disagree,
  PROTOCOL.md wins.
- A recipe changes no rule. A recipe that needs a change to the wire becomes
  a change to PROTOCOL.md, or an extension. Until that change has proved
  itself, a recipe can carry it as a draft extension, which can still change.

Each recipe has its own file in [recipes/](recipes/):

- [Passkeys in native apps](recipes/native_passkeys.md): Can a native app,
  such as one for macOS, iOS, Android, or Linux, sign in with a server's
  passkeys?
- [Trusted federation](recipes/trusted_federation.md): Can two Apron servers
  share rooms?
- [Bots](recipes/bot.md) (draft): Can a bot stay offline until a message
  needs it?
