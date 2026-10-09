#!/bin/bash
# soak.sh <rounds> <out>: each round rings a bell on another fm-* tab, returns
# to tab 1, waits 15 s, then records agents.json and the tab colours.
A=/var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/cfg/plugin-data/firstmate-agents/agents.json; out=$2; : > $out
for k in $(seq 1 $1); do
  t=$((k*3+1)); /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/c tab $t >/dev/null; /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/c alert bell lab >/dev/null; /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/c tab 1 >/dev/null
  sleep 15
  printf '%s round=%s bell_on_tab=%s agents.json mtime=%s waiting_blocks=%s fm_blocks=%s | coloured_tabs=%s | budget_lines=%s\n'     "$(date +%T)" $k $t "$(stat -f %Sm -t %T $A)"     "$(jq '[.blocks[]|select(.shown=="waiting_input")]|length' $A)"     "$(jq '[.blocks[]|select(.tab_name!=null and (.tab_name|startswith("fm-")))]|length' $A)"     "$(/var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/c state | jq -c '[.tabs[]|select(.color!=null)|"\(.title)=\(.color)"]')"     "$(grep -c 'exceeded its budget' /var/folders/c7/bb78qxx56b52ttgxx5bmdknm0000gn/T/fmlab3.5Hss/logs/tern-serve.log)" | tee -a $out
done
