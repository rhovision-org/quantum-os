"""Patch only the disposable checkout's harness, never the pinned node source."""
import pathlib, sys
p=pathlib.Path(sys.argv[1])
s=p.read_text()
def replace(a,b):
    global s
    assert s.count(a)==1, a
    s=s.replace(a,b)
replace('  # Liveness enforcement (RCHIP #55, Law 89) is a *genesis* parameter block.', '''  # Fund only the committed public test-wallet fixtures; all nodes share genesis.
  cat "$OMEGA_FIXTURE_WALLETS" >> "$dir/wallets.txt"
  # Liveness enforcement (RCHIP #55, Law 89) is a *genesis* parameter block.''')
replace('local ports="-p ${http_host}:40403"','local ports="-p 127.0.0.1:${http_host}:40403"')
replace('ports="-p ${grpc_host}:40401 $ports"','ports="-p 127.0.0.1:${grpc_host}:40401 $ports"')
replace('ports="$ports -p ${admin_host}:40405"','ports="$ports -p 127.0.0.1:${admin_host}:40405"')
p.write_text(s)
