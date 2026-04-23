# Linux sysctl Tuning for High-Frequency WebSocket Ingestion

These kernel parameters reduce latency and increase throughput for the Node.js
ingestion layer. Apply them by writing to `/etc/sysctl.d/99-trading.conf` and
running `sudo sysctl --system`.

---

## 1. Socket Receive / Send Buffers

The default Linux socket buffer is only 212 KB. For a 100 ms depth stream
plus a Polymarket L2 feed, you want room for several milliseconds of bursts
without kernel-side drops.

```ini
# /etc/sysctl.d/99-trading.conf

# Maximum socket buffer sizes (bytes)
net.core.rmem_max = 134217728   # 128 MiB — receive
net.core.wmem_max = 134217728   # 128 MiB — send

# Default sizes allocated per new socket
net.core.rmem_default = 16777216  # 16 MiB
net.core.wmem_default = 16777216  # 16 MiB

# TCP-specific min/default/max (bytes)
net.ipv4.tcp_rmem = 4096 16777216 134217728
net.ipv4.tcp_wmem = 4096 16777216 134217728
```

---

## 2. Network Device Queue

Increase the kernel's per-CPU receive queue before the packet processor runs,
preventing drops at line rate.

```ini
net.core.netdev_max_backlog = 250000
```

---

## 3. TCP Congestion & Fast Path

```ini
# BBR is well-suited for low-RTT LAN/datacenter links.
# Use 'cubic' if connecting to remote endpoints over variable-RTT paths.
net.ipv4.tcp_congestion_control = bbr

# TCP Fast Open — skips the SYN/SYN-ACK round-trip on reconnects (requires
# kernel ≥ 3.7 and server support). 3 = enable for both client and server.
net.ipv4.tcp_fastopen = 3

# SACK improves loss recovery without full retransmit.
net.ipv4.tcp_sack = 1

# RTTM timestamps improve RTT estimates and PAWS protection.
net.ipv4.tcp_timestamps = 1

# Don't cache TCP metrics between short-lived connections (e.g. reconnects).
net.ipv4.tcp_no_metrics_save = 1
```

---

## 4. TIME_WAIT Recycling

Each WebSocket reconnect leaves a socket in TIME_WAIT for 60 s by default.
On a high-reconnect system this can exhaust local port ranges.

```ini
# Reduce TIME_WAIT from 60 s to 15 s.
net.ipv4.tcp_fin_timeout = 15

# Allow rapid reuse of TIME_WAIT sockets for new outbound connections.
net.ipv4.tcp_tw_reuse = 1

# Expand the ephemeral port range (default: 32768–60999).
net.ipv4.ip_local_port_range = 1024 65535
```

---

## 5. Memory & Swap

Worker threads performing real-time processing must not be paged out.

```ini
# Strongly prefer keeping process memory in RAM.
vm.swappiness = 1

# Raise the threshold at which the kernel starts aggressive writeback.
vm.dirty_ratio = 60
vm.dirty_background_ratio = 5
```

---

## 6. File Descriptor Limits

Each WebSocket + QuestDB socket consumes an fd. Raise the per-process limit in
`/etc/security/limits.conf` or via the systemd unit:

```
# /etc/security/limits.conf
*  soft  nofile  1048576
*  hard  nofile  1048576
```

Or, if running via systemd:

```ini
# In the [Service] section of the unit file
LimitNOFILE=1048576
```

---

## 7. CPU Affinity (optional, high-frequency environments)

Pin the Node.js process to isolated cores to eliminate scheduler jitter:

```bash
# Isolate cores 2 and 3 at boot (add to GRUB_CMDLINE_LINUX in /etc/default/grub)
isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3

# Run the process pinned to those cores
taskset -c 2,3 node src/main.js
```

---

## 8. Apply Changes

```bash
# Write the file
sudo tee /etc/sysctl.d/99-trading.conf << 'EOF'
net.core.rmem_max          = 134217728
net.core.wmem_max          = 134217728
net.core.rmem_default      = 16777216
net.core.wmem_default      = 16777216
net.ipv4.tcp_rmem          = 4096 16777216 134217728
net.ipv4.tcp_wmem          = 4096 16777216 134217728
net.core.netdev_max_backlog = 250000
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_fastopen      = 3
net.ipv4.tcp_sack          = 1
net.ipv4.tcp_timestamps    = 1
net.ipv4.tcp_no_metrics_save = 1
net.ipv4.tcp_fin_timeout   = 15
net.ipv4.tcp_tw_reuse      = 1
net.ipv4.ip_local_port_range = 1024 65535
vm.swappiness              = 1
vm.dirty_ratio             = 60
vm.dirty_background_ratio  = 5
EOF

# Activate without reboot
sudo sysctl --system
```

---

## 9. Verify

```bash
# Confirm BBR is active on a socket
ss -tin dst <questdb-host>

# Watch for kernel buffer drops on the NIC (drops column should stay at 0)
watch -n1 'cat /proc/net/dev | grep <interface>'

# Monitor socket receive queue depth (Recv-Q should stay near 0)
watch -n1 'ss -tn | grep 9009'
```
