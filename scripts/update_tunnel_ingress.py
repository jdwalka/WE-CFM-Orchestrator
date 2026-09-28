import sys

path = '/home/mauro/.cloudflared/config-gemini-bridge.yml'
with open(path, 'r') as f:
    content = f.read()

jdwalkaz_block = """  # ── jdwalkaz.leaksnipe.win ──────────────────────────────────────────────
  # Canonical jdwalkaz agent & bridge — replaces truffle
  - hostname: jdwalkaz.leaksnipe.win
    service: http://localhost:8040
    originRequest:
      connectTimeout: 10s

"""

if 'hostname: jdwalkaz.leaksnipe.win' not in content:
    content = content.replace('ingress:\n', 'ingress:\n' + jdwalkaz_block)
    with open(path, 'w') as f:
        f.write(content)
    print('Updated config-gemini-bridge.yml with jdwalkaz.leaksnipe.win')
else:
    print('Already present')
