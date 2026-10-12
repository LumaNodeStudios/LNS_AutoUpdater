const https = require('https');
const url = require('url');

class GitHubClient {
    constructor(token = null) {
        this.token = token;
        this.userAgent = 'FiveM-AutoUpdater-Resource';
    }

    request(requestUrl, options = {}) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new url.URL(requestUrl);
            const headers = {
                'User-Agent': this.userAgent,
                'Accept': options.accept || 'application/vnd.github.v3+json',
                ...(options.headers || {})
            };

            if (this.token) {
                headers['Authorization'] = this.token.startsWith('Bearer ') || this.token.startsWith('token ')
                    ? this.token
                    : `Bearer ${this.token}`;
            }

            const reqOptions = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 443,
                path: parsedUrl.pathname + parsedUrl.search,
                method: options.method || 'GET',
                headers
            };

            const req = https.request(reqOptions, (res) => {
                if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                    return this.request(res.headers.location, options).then(resolve).catch(reject);
                }

                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const data = Buffer.concat(chunks);
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        data
                    });
                });
            });

            req.on('error', err => reject(err));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Request timed out for ${requestUrl}`));
            });

            req.setTimeout(options.timeout || 30000);
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
            timeout: 60000
        });
        this.handleHttpErrors(res, `${repo}@${ref}`);

        return res.data;
    }
}

module.exports = GitHubClient;
