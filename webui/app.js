class DenoProxyUI {
    constructor() {
        this.apiUrl = localStorage.getItem('denoproxy_api_url') || '';
        this.refreshInterval = parseInt(localStorage.getItem('denoproxy_refresh_rate')) || 3000;
        this.logLevel = localStorage.getItem('denoproxy_log_level') || 'INFO';
        this.logs = [];
        this.dataEventSource = null;
        this.logEventSource = null;
        this.init();
    }

    init() {
        this.setupNavigation();
        this.setupConfigModal();
        this.setupButtons();
        
        if (!this.apiUrl) {
            this.showConfigModal();
        } else {
            this.startMonitoring();
        }
    }

    setupNavigation() {
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const view = item.dataset.view;
                this.switchView(view);
                
                document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
            });
        });
    }

    switchView(view) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById(`view-${view}`).classList.add('active');
        
        const titles = {
            dashboard: '仪表盘',
            connections: '连接',
            metrics: '指标',
            logs: '日志'
        };
        document.getElementById('pageTitle').textContent = titles[view];
    }

    setupConfigModal() {
        const modal = document.getElementById('configModal');
        const openBtn = document.getElementById('openConfig');
        const closeBtn = document.getElementById('closeModal');
        const cancelBtn = document.getElementById('cancelConfig');
        const saveBtn = document.getElementById('saveConfig');
        const apiInput = document.getElementById('apiUrl');
        const rateSelect = document.getElementById('refreshRate');

        openBtn.addEventListener('click', () => {
            apiInput.value = this.apiUrl;
            rateSelect.value = this.refreshInterval;
            this.showConfigModal();
        });

        closeBtn.addEventListener('click', () => this.hideConfigModal());
        cancelBtn.addEventListener('click', () => this.hideConfigModal());
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hideConfigModal();
        });

        saveBtn.addEventListener('click', () => {
            const url = apiInput.value.trim();
            if (!url) {
                this.showToast('请输入API地址', 'error');
                return;
            }
            
            // 移除末尾的斜杠，避免路径问题
            this.apiUrl = url.replace(/\/$/, '');
            this.refreshInterval = parseInt(rateSelect.value);
            
            localStorage.setItem('denoproxy_api_url', this.apiUrl);
            localStorage.setItem('denoproxy_refresh_rate', this.refreshInterval);
            
            this.hideConfigModal();
            this.stopMonitoring();
            this.startMonitoring();
            this.showToast('配置已保存', 'success');
        });
    }

    showConfigModal() {
        document.getElementById('configModal').classList.add('active');
    }

    hideConfigModal() {
        document.getElementById('configModal').classList.remove('active');
    }

    setupButtons() {
        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.fetchData();
        });

        document.getElementById('resetMetrics').addEventListener('click', () => {
            this.resetMetrics();
        });

        document.getElementById('clearLogs').addEventListener('click', () => {
            this.logs = [];
            this.renderLogs();
        });

        // 日志级别切换
        const logLevelSelect = document.getElementById('logLevel');
        if (logLevelSelect) {
            logLevelSelect.value = this.logLevel;
            logLevelSelect.addEventListener('change', (e) => {
                this.logLevel = e.target.value;
                localStorage.setItem('denoproxy_log_level', this.logLevel);
                this.logs = []; // 清空旧日志
                this.renderLogs();
                this.connectSSE(); // 重新连接
                this.showToast(`日志级别已切换为 ${this.logLevel}`, 'success');
            });
        }
    }

    async fetchData() {
        try {
            const [health, connections, stats] = await Promise.all([
                this.fetchAPI('health'),
                this.fetchAPI('connections'),
                this.fetchAPI('stats')
            ]);

            this.updateDashboard(health, connections, stats);
            this.updateConnections(connections);
            this.updateMetrics(stats);
            this.setConnectionStatus(true);
        } catch (error) {
            this.setConnectionStatus(false);
        }
        
        this.updateLastUpdate();
    }

    async fetchAPI(endpoint) {
        const url = this.apiUrl.includes('?') 
            ? `${this.apiUrl}&api=${endpoint}`
            : `${this.apiUrl}?api=${endpoint}`;
        
        const startTime = performance.now();
        this.log(`→ GET ${url}`, 'info');
        
        try {
            const response = await fetch(url);
            const duration = (performance.now() - startTime).toFixed(1);
            
            if (!response.ok) {
                this.log(`✗ ${endpoint} 失败: HTTP ${response.status} (${duration}ms)`, 'error');
                throw new Error(`HTTP ${response.status}`);
            }
            
            const contentType = response.headers.get('content-type');
            if (!contentType?.includes('application/json')) {
                this.log(`✗ ${endpoint} 失败: 非JSON响应 (${duration}ms)`, 'error');
                throw new Error('返回了非JSON响应');
            }
            
            const data = await response.json();
            const size = JSON.stringify(data).length;
            this.log(`✓ ${endpoint} 成功: ${size} bytes (${duration}ms)`, 'success');
            
            return data;
        } catch (error) {
            const duration = (performance.now() - startTime).toFixed(1);
            this.log(`✗ ${endpoint} 错误: ${error.message} (${duration}ms)`, 'error');
            throw error;
        }
    }

    updateDashboard(health) {
        document.getElementById('uptime').textContent = this.formatDuration(health.uptimeSeconds);
        
        // 从 health 中获取连接数
        const connCount = health.connections?.active || 0;
        const totalCount = health.connections?.total || 0;
        document.getElementById('activeConns').textContent = connCount;
        document.getElementById('connBadge').textContent = totalCount;
        
        const mem = health.memory || {};
        const heapUsed = mem.heapUsedMB || 0;
        const heapTotal = mem.heapTotalMB || 1;
        const memPercent = Math.round((heapUsed / heapTotal) * 100);
        
        document.getElementById('memoryUsage').textContent = `${heapUsed} MB`;
        document.getElementById('memoryProgress').style.width = `${memPercent}%`;
        
        document.getElementById('reqPerMin').textContent = health.metrics?.requests?.perMinute || 0;

        const sysInfo = document.getElementById('systemInfo');
        sysInfo.innerHTML = `
            <div class="info-item">
                <span class="info-label">Deno 版本</span>
                <span class="info-value">${health.deno?.version || '-'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">主机名</span>
                <span class="info-value">${health.system?.hostname || '-'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">CPU 核心</span>
                <span class="info-value">${health.system?.cpus || '-'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">平台</span>
                <span class="info-value">${health.deno?.build?.os || '-'}</span>
            </div>
        `;

        const memStats = document.getElementById('memoryStats');
        memStats.innerHTML = `
            <div class="memory-stat">
                <span class="memory-label">RSS</span>
                <span class="memory-value">${mem.rssMB || 0} MB</span>
            </div>
            <div class="memory-stat">
                <span class="memory-label">Heap Used</span>
                <span class="memory-value">${mem.heapUsedMB || 0} MB</span>
            </div>
            <div class="memory-stat">
                <span class="memory-label">Heap Total</span>
                <span class="memory-value">${mem.heapTotalMB || 0} MB</span>
            </div>
        `;
    }

    updateConnections(data) {
        const tbody = document.getElementById('connectionsTable');
        const conns = data.connections || [];
        
        document.getElementById('connSummary').textContent = `共 ${data.total || 0} 个连接`;
        
        if (conns.length === 0) {
            tbody.innerHTML = '<tr class="empty"><td colspan="6">暂无连接</td></tr>';
            return;
        }
        
        tbody.innerHTML = conns.map(conn => `
            <tr>
                <td><code>${conn.id.slice(0, 8)}</code></td>
                <td>${this.formatTime(conn.connectedAt)}</td>
                <td>${this.formatTime(conn.lastActivity)}</td>
                <td>${this.formatDuration(Math.floor(conn.duration / 1000))}</td>
                <td>${conn.reconnectCount}</td>
                <td><span class="status-badge ${conn.idle ? 'idle' : 'online'}">${conn.idle ? '空闲' : '活跃'}</span></td>
            </tr>
        `).join('');
    }

    updateMetrics(data) {
        const metrics = data.metrics || {};
        const requests = metrics.requests || {};
        
        document.getElementById('requestMetrics').innerHTML = `
            <div class="metric-item">
                <span class="metric-name">请求/秒</span>
                <span class="metric-value">${requests.perSecond || 0}</span>
            </div>
            <div class="metric-item">
                <span class="metric-name">请求/分钟</span>
                <span class="metric-value">${requests.perMinute || 0}</span>
            </div>
            <div class="metric-item">
                <span class="metric-name">总请求数</span>
                <span class="metric-value">${requests.total || 0}</span>
            </div>
        `;
        
        const counters = metrics.counters || {};
        const counterHtml = Object.entries(counters).map(([k, v]) => `
            <div class="metric-item">
                <span class="metric-name">${k}</span>
                <span class="metric-value">${v}</span>
            </div>
        `).join('');
        
        document.getElementById('counterMetrics').innerHTML = counterHtml || '<div class="metric-item"><span class="metric-name">暂无数据</span></div>';
    }

    async resetMetrics() {
        try {
            const response = await fetch(`${this.apiUrl}?api=reset`, { method: 'POST' });
            if (response.ok) {
                this.showToast('指标已重置', 'success');
                this.fetchData();
            }
        } catch (error) {
            this.showToast('重置失败', 'error');
        }
    }

    setConnectionStatus(online) {
        const dot = document.querySelector('#connStatus .status-dot');
        const text = document.querySelector('#connStatus .status-text');
        
        if (online) {
            dot.classList.add('online');
            text.textContent = '已连接';
        } else {
            dot.classList.remove('online');
            text.textContent = '未连接';
        }
    }

    startMonitoring() {
        this.connectDataSSE();
        this.connectLogSSE();
    }

    stopMonitoring() {
        if (this.dataEventSource) {
            this.dataEventSource.close();
            this.dataEventSource = null;
        }
        if (this.logEventSource) {
            this.logEventSource.close();
            this.logEventSource = null;
        }
    }

    connectDataSSE() {
        if (this.dataEventSource) {
            this.dataEventSource.close();
        }

        // 使用单个SSE连接获取所有数据
        const url = this.apiUrl.includes('?')
            ? `${this.apiUrl}&api=health&sse=true`
            : `${this.apiUrl}?api=health&sse=true`;

        try {
            this.dataEventSource = new EventSource(url);

            this.dataEventSource.onopen = () => {
                this.setConnectionStatus(true);
            };

            this.dataEventSource.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'health') {
                        this.updateDashboard(msg.data);
                    }
                } catch (err) {
                    console.error('解析数据失败:', err);
                }
            };

            this.dataEventSource.onerror = () => {
                this.setConnectionStatus(false);
                // 5秒后重连
                setTimeout(() => this.connectDataSSE(), 5000);
            };
        } catch (err) {
            this.setConnectionStatus(false);
        }
    }

    connectLogSSE() {
        if (this.logEventSource) {
            this.logEventSource.close();
        }

        const url = this.apiUrl.includes('?')
            ? `${this.apiUrl}&api=logs&level=${this.logLevel}`
            : `${this.apiUrl}?api=logs&level=${this.logLevel}`;

        try {
            this.logEventSource = new EventSource(url);

            this.logEventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.addServerLog(data);
                } catch (err) {
                    console.error('解析日志失败:', err);
                }
            };

            this.logEventSource.onerror = () => {
                // 5秒后重连
                setTimeout(() => this.connectLogSSE(), 5000);
            };
        } catch (err) {
            console.error('日志SSE错误:', err);
        }
    }

    addServerLog(entry) {
        const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN');
        const level = entry.level.toLowerCase();
        let message = entry.message;

        // 如果有额外数据，格式化显示
        if (entry.data && Object.keys(entry.data).length > 0) {
            const dataStr = Object.entries(entry.data)
                .map(([k, v]) => `${k}=${v}`)
                .join(' ');
            message += ` | ${dataStr}`;
        }

        this.logs.push({ time, level, message });
        if (this.logs.length > 500) this.logs.shift();
        this.renderLogs();
    }

    log(message, level = 'info') {
        const time = new Date().toLocaleTimeString('zh-CN');
        this.logs.push({ time, level, message });
        if (this.logs.length > 100) this.logs.shift();
        this.renderLogs();
    }

    renderLogs() {
        const container = document.getElementById('logsContainer');
        if (this.logs.length === 0) {
            container.innerHTML = '<div class="log-entry info"><span class="log-time">-</span><span class="log-level">INFO</span><span class="log-msg">暂无日志</span></div>';
            return;
        }
        
        container.innerHTML = this.logs.map(log => `
            <div class="log-entry ${log.level}">
                <span class="log-time">${log.time}</span>
                <span class="log-level">${log.level.toUpperCase()}</span>
                <span class="log-msg">${log.message}</span>
            </div>
        `).join('');
        
        container.scrollTop = container.scrollHeight;
    }

    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        document.getElementById('toastMsg').textContent = message;
        toast.className = `toast ${type} show`;
        
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    updateLastUpdate() {
        document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString('zh-CN');
    }

    formatDuration(seconds) {
        if (!seconds) return '-';
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    formatTime(iso) {
        if (!iso) return '-';
        return new Date(iso).toLocaleTimeString('zh-CN');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new DenoProxyUI();
});
