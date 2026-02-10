# DenoProxy

基于 Deno 的高性能代理系统，支持 HTTP、SOCKS5、TCP、UDP 和 DNS 代理，使用 WebSocket 作为传输协议。

## 特性

- **多协议支持**: HTTP 代理、SOCKS5 代理（TCP/UDP）、TCP 转发、DNS 查询
- **智能路由**: 基于 GeoIP 的直连/代理自动决策
- **Keep-Alive**: HTTP 持久连接支持
- **自动重连**: 指数退避重连机制
- **二进制协议**: 高效的自定义二进制通信协议
- **连接管理**: 服务端连接限制、健康检查、速率限制

## 架构

```
┌─────────────┐      WebSocket       ┌─────────────┐
│   Client    │ ◄──────────────────► │   Server    │
│  (本地代理)  │                      │  (远程转发)  │
└──────┬──────┘                      └──────┬──────┘
       │                                     │
   HTTP/SOCKS5                         TCP/UDP/DNS
       │                                     │
   应用客户端                           目标服务器
```

### 核心组件

| 模块 | 文件 | 说明 |
|------|------|------|
| Protocol | `core/protocol.ts` | 消息类型定义（TCP/UDP/DNS/HTTP/心跳） |
| Codec | `core/codec.ts` | 二进制消息编解码 |
| Client | `core/client.ts` | WebSocket 客户端，请求管理 |
| Transport | `core/transport.ts` | 服务端 WebSocket 处理器 |
| TCP Proxy | `core/protocol/tcp.ts` | TCP 连接转发 |
| UDP Proxy | `core/protocol/udp.ts` | UDP 数据报转发 |
| DNS Proxy | `core/protocol/dns.ts` | DNS 查询代理 |
| HTTP Proxy | `core/protocol/http-proxy.ts` | HTTP 请求代理 |
| Command | `core/command.ts` | 控制命令系统 |

## 快速开始

### 1. 启动服务端

```bash
deno task server

# 自定义端口
deno task server --port 9000

# 启用 TLS
deno task server --tls-cert cert.pem --tls-key key.pem
```

### 2. 启动客户端

```bash
deno task client

# 连接到远程服务端
deno task client --remote ws://your-server:8080

# 使用 GeoIP 智能路由
deno task client --mmdb ./Country.mmdb
```

### 3. 配置系统代理

客户端默认监听 `127.0.0.1:7890`，支持 HTTP 和 SOCKS5 协议。

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export ALL_PROXY=socks5://127.0.0.1:7890
```

## 二进制协议

### 消息格式

```
┌────────┬────────────┬─────────┐
│ Type   │ ResourceId │ Data    │
│ 1 byte │ 4 bytes    │ N bytes │
└────────┴────────────┴─────────┘
```

### 消息类型

| 类型 | 值 | 说明 |
|------|-----|------|
| TCP_CONNECT | 0x01 | TCP 连接请求 |
| TCP_CONNECT_ACK | 0x02 | TCP 连接确认 |
| TCP_DATA | 0x03 | TCP 数据 |
| TCP_CLOSE | 0x04 | TCP 关闭 |
| UDP_BIND | 0x11 | UDP 绑定 |
| UDP_DATA | 0x13 | UDP 数据 |
| DNS_QUERY | 0x21 | DNS 查询 |
| HTTP_REQUEST | 0x31 | HTTP 请求 |
| HTTP_RESPONSE | 0x32 | HTTP 响应 |
| HEARTBEAT | 0xFF | 心跳保活 |

## 命令系统

客户端和服务端支持通过 WebSocket 文本帧发送控制命令：

```
SET UUID <uuid>       # 设置客户端 UUID
GET STATUS            # 获取连接状态
GET INFO              # 获取系统信息
GET VERSION           # 获取版本信息
STATS                 # 获取统计信息
PING                  # 心跳测试
HELP                  # 显示帮助
```

响应格式（JSON）：
```json
{
  "success": true,
  "message": "PONG",
  "data": { "timestamp": 1234567890 }
}
```

## 配置选项

### 服务端

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | 8080 | 监听端口 |
| `--hostname` | 0.0.0.0 | 监听地址 |
| `--log-level` | info | 日志级别 (debug/info/warn/error) |
| `--max-connections` | 1000 | 最大连接数 |
| `--connection-timeout` | 300000 | 连接超时(ms) |
| `--tls-cert` | - | TLS 证书路径 |
| `--tls-key` | - | TLS 私钥路径 |
| `--connect-path` | `/` | WebSocket连接路径 |

### 客户端

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--remote` | ws://localhost:8080 | 服务端地址 |
| `--port` | 7890 | 本地代理端口 |
| `--hostname` | 127.0.0.1 | 本地监听地址 |
| `--mmdb` | ./Country.mmdb | GeoIP 数据库路径 |

## 智能路由

当提供 MaxMind GeoIP 数据库时，客户端会自动判断目标 IP 是否属于中国：

- **中国 IP**: 直接连接（不经过代理）
- **海外 IP**: 通过 WebSocket 代理

```bash
# 下载 GeoIP 数据库
wget https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-Country.mmdb

# 启动客户端
 deno run -A client/main.ts --mmdb GeoLite2-Country.mmdb
```

## 开发

### 目录结构

```
.
├── client/          # 客户端代码
│   ├── main.ts      # 入口
│   ├── http.ts      # HTTP 代理处理器
│   ├── socks5.ts    # SOCKS5 代理处理器
│   ├── server.ts    # 本地混合代理服务器
│   ├── geoip.ts     # GeoIP 管理
│   └── proxy-decision.ts  # 路由决策
├── server/          # 服务端代码
│   ├── main.ts      # 入口
│   ├── manager.ts   # 连接管理
│   ├── config.ts    # 配置解析
│   └── middleware.ts # 中间件（速率限制、健康检查）
├── core/            # 核心协议
│   ├── protocol.ts  # 协议定义
│   ├── codec.ts     # 编解码
│   ├── client.ts    # 客户端核心
│   ├── transport.ts # 服务端传输
│   ├── command.ts   # 命令系统
│   └── protocol/    # 协议处理器
│       ├── tcp.ts
│       ├── udp.ts
│       ├── dns.ts
│       └── http-proxy.ts
├── utils/           # 工具
│   ├── error.ts     # 错误处理
│   └── bjson.ts     # 二进制 JSON
└── deno.json        # Deno 配置
```

### 运行测试

```bash
# 类型检查
deno check server/main.ts client/main.ts

# 启动服务端
deno run -A server/main.ts --log-level debug

# 启动客户端（另一个终端）
deno run -A client/main.ts --log-level debug
```

## 技术细节

### Keep-Alive 实现

HTTP 代理支持持久连接：
- HTTP/1.1 默认启用 keep-alive
- 循环读取多个请求直到客户端关闭或超时
- 正确处理 `Connection` 和 `Proxy-Connection` 头

### 连接池

- TCP 连接通过 `resourceId` 标识复用
- UDP 支持多会话管理
- 服务端自动清理空闲连接

### 错误处理

- WebSocket 断开自动重连（指数退避）
- 请求超时处理
- 优雅的资源清理

## 安全建议

1. 生产环境使用 TLS 加密 WebSocket 连接
2. 设置合理的速率限制防止滥用
3. 限制最大连接数防止资源耗尽
4. 定期更新 GeoIP 数据库
5. 务必自定义 WebSocket 路径，避免被他人盗用

## 许可证

MIT
