const https = require('https');
const url = require('url');

class GitHubClient {
    constructor(token = null) {
        this.token = token;
        this.userAgent = 'LumaNode-AutoUpdater-Resource';
    }

    request(requestUrl, options = {}, redirectCount = 0, retriesLeft = 2) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new url.URL(requestUrl);
            const headers = {
                'User-Agent': this.userAgent,
                'Accept': options.accept || 'application/vnd.github.v3+json',
                'Connection': 'close',
                ...(options.headers || {})
            };

            if (this.token && (!options.headers || !options.headers['Authorization'])) {
                if (parsedUrl.hostname === 'api.github.com' || parsedUrl.hostname.endsWith('.github.com')) {
                    headers['Authorization'] = this.token.startsWith('Bearer ') || this.token.startsWith('token ')
                        ? this.token
                        : `Bearer ${this.token}`;
                }
            }

            const reqOptions = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 443,
                path: parsedUrl.pathname + parsedUrl.search,
                method: options.method || 'GET',
                headers
            };

            const handleError = (err) => {
                const isRetryable = err && (
                    err.code === 'ECONNRESET' ||
                    err.code === 'ETIMEDOUT' ||
                    err.code === 'EAI_AGAIN' ||
                    (err.message && err.message.includes('ECONNRESET'))
                );

                if (isRetryable && retriesLeft > 0) {
                    setTimeout(() => {
                        this.request(requestUrl, options, redirectCount, retriesLeft - 1)
                            .then(resolve)
                            .catch(reject);
                    }, 1000);
                } else {
                    reject(err);
                }
            };

            const timeoutMs = options.timeout || 60000;

            const req = https.request(reqOptions, (res) => {
                if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    if (redirectCount >= 5) {
                        return reject(new Error(`Too many redirects encountered for ${requestUrl}`));
                    }
                    const nextUrl = new url.URL(res.headers.location, requestUrl).toString();
                    const nextOptions = { ...options };
                    if (new url.URL(nextUrl).hostname !== 'api.github.com') {
                        if (nextOptions.headers) {
                            const newH = { ...nextOptions.headers };
                            delete newH['Authorization'];
                            nextOptions.headers = newH;
                        }
                    }
                    return this.request(nextUrl, nextOptions, redirectCount + 1, retriesLeft).then(resolve).catch(reject);
                }

                const chunks = [];
                res.on('data', chunk => {
                    chunks.push(chunk);
                    req.setTimeout(timeoutMs);
                });

                res.on('error', handleError);

                res.on('end', () => {
                    const data = Buffer.concat(chunks);
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        data
                    });
                });
            });

            req.on('error', handleError);
            req.on('timeout', () => {
                req.destroy(new Error(`Request timed out after ${timeoutMs}ms for ${requestUrl}`));
            });

            req.setTimeout(timeoutMs);
            req.end();
        });
    }

    handleHttpErrors(res, repoContext = '') {
        if (res.statusCode === 403) {
            const limit = res.headers && res.headers['x-ratelimit-remaining'];
            if (limit === '0') {
                const resetEpoch = parseInt(res.headers['x-ratelimit-reset'], 10);
                const resetTime = !isNaN(resetEpoch) ? new Date(resetEpoch * 1000).toLocaleTimeString() : 'soon';
                throw new Error(`GitHub API rate limit exceeded (resets at ${resetTime}). Add a "githubToken" to config.json for 5,000 requests/hr.`);
            }
            throw new Error(`GitHub API returned 403 Forbidden: ${res.data.toString('utf8')}`);
        }
        if (res.statusCode === 404) {
            throw new Error(`Resource or repository not found: ${repoContext}. Check repo name, releases, or branch.`);
        }
        if (res.statusCode !== 200) {
            throw new Error(`GitHub API error (${res.statusCode}): ${res.data.toString('utf8')}`);
        }
    }

    async getLatestCommit(repo, branch = 'main') {
        const endpoint = `https://api.github.com/repos/${repo}/commits/${branch}`;
        const res = await this.request(endpoint);
        this.handleHttpErrors(res, `${repo}@${branch}`);

        const data = JSON.parse(res.data.toString('utf8'));
        return {
            sha: data.sha,
            shortSha: data.sha.substring(0, 7),
            message: data.commit.message.split('\n')[0],
            author: data.commit.author.name,
            date: data.commit.author.date,
            url: data.html_url
        };
    }

    async getLatestRelease(repo) {
        const endpoint = `https://api.github.com/repos/${repo}/releases/latest`;
        const res = await this.request(endpoint);
        this.handleHttpErrors(res, repo);

        const data = JSON.parse(res.data.toString('utf8'));
        return {
            tagName: data.tag_name,
            name: data.name || data.tag_name,
            body: data.body,
            publishedAt: data.published_at,
            zipballUrl: data.zipball_url,
            url: data.html_url
        };
    }

    async downloadZipball(repo, ref = 'main') {
        const endpoint = `https://api.github.com/repos/${repo}/zipball/${encodeURIComponent(ref)}`;
        const res = await this.request(endpoint, {
            accept: 'application/vnd.github.v3+json',
            timeout: 180000
        });
        this.handleHttpErrors(res, `${repo}@${ref}`);

        return res.data;
    }
}

module.exports = GitHubClient;
