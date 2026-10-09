#!/bin/bash
# up.sh: start an isolated serve and open 30 retitling fm-* tabs
export STENCIL_FIXTURE_ROOT=/var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/crates/tern TERN_CONFIG_DIR=/var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/cfg TERN_DAEMON_SOCKET=/var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/daemon.sock STENCIL_LOG_DIR=/var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/logs
rm -f /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/logs/*; cd /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss
nohup tern serve --control /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/ctl.sock --out /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/out >/var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/serve.log 2>&1 &
for i in $(seq 50); do [ -S /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/ctl.sock ] && /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/c state >/dev/null 2>&1 && break; sleep 0.2; done
/var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/c tabs vertical >/dev/null
/var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/c plugins fixtures
for n in $(seq -w 1 30); do
  /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/c tab new >/dev/null; /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/c rename fm-$n >/dev/null; /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/c run "\"zsh /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/spin.sh $n\"" >/dev/null
done
/var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/c state | jq -c '{tabs: (.tabs|length), orientation: .tab_orientation}'
