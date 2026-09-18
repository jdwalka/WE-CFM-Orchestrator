import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, "/home/mauro/leaksnipe-mcp-agent")

import mcp_agent

res = mcp_agent.get_live_cascade_audit("BTC")
print(f"Audit OK: {res.get('ok')}")
if res.get("ok"):
    print(f"Verdict: {res['telemetry']['verdict']}")
    print(f"Coherence: {res['telemetry']['cascade_coherence_index']}")
    print(f"Action: {res['telemetry']['recommended_action']}")
else:
    print(f"Error: {res.get('error')}")

assert res.get("ok") is True, "Cascade audit should succeed"
print("\nmcp_agent cascade integration test PASSED!")
