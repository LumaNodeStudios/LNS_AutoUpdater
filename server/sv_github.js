/**
 * GitHub API client for fetching repository metadata, releases, and zipball archives.
 * Pure Node.js https implementation without external dependencies.
 */

const https = require('https');
const url = require('url');

class GitHubClient {
    constructor(token = null) {
        this.token = token;
        this.userAgent = 'FiveM-AutoUpdater-Resource';
    }

    /**
     * Helper to make HTTPS requests with redirect support and rate-limit detection.
     * @param {string} requestUrl 
     * @param {Object} options 
     * @returns {Promise<{ statusCode: number, headers: Object, data: Buffer }>}
     */
    request(requestUrl, options = {}) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new url.URL(requestUrl);
            const headers = {
                'User-Agent': this.userAgent,
                'Accept': options.accept || 'application/vnd.github.v3+json',
                ...(options.headers || {})
            };

            if (this.token) {
                headers['Authorization'] = `token ${this.token}`;
            }

            const reqOptions = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 443,
                path: parsedUrl.pathname + parsedUrl.search,
                method: options.method || 'GET',
                headers
            };

            const req = https.request(reqOptions, (res) => {
                // Handle 301, 302, 307 redirects (common when downloading GitHub zipballs)
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

    /**
     * Get the latest commit on a branch.
     * @param {string} repo - 'owner/repo'
     * @param {string} branch - e.g. 'main' or 'master'
     */
    async getLatestCommit(repo, branch = 'main') {
        const endpoint = `https://api.github.com/repos/${repo}/commits/${branch}`;
        const res = await this.request(endpoint);

        if (res.statusCode === 404) {
            throw new Error(`Repository or branch not found: ${repo}@${branch}. Check repo name and permissions.`);
        }
        if (res.statusCode === 403) {
            const limit = res.headers['x-ratelimit-remaining'];
            if (limit === '0') {
                const resetTime = new Date(parseInt(res.headers['x-ratelimit-reset']) * 1000).toLocaleTimeString();
                throw new Error(`GitHub API rate limit exceeded. Resets at ${resetTime}. Provide a githubToken in config.json to increase rate limits.`);
            }
            throw new Error(`GitHub API returned 403 Forbidden: ${res.data.toString()}`);
        }
        if (res.statusCode !== 200) {
            throw new Error(`GitHub API error (${res.statusCode}): ${res.data.toString()}`);
        }

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

    /**
     * Get the latest release from GitHub.
     * @param {string} repo - 'owner/repo'
     */
    async getLatestRelease(repo) {
        const endpoint = `https://api.github.com/repos/${repo}/releases/latest`;
        const res = await this.request(endpoint);

        if (res.statusCode === 404) {
            throw new Error(`No releases found for ${repo}. Consider tracking branch commits instead.`);
        }
        if (res.statusCode !== 200) {
            throw new Error(`GitHub API release error (${res.statusCode}): ${res.data.toString()}`);
        }

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

    /**
     * Download the repository zip archive for a given ref (branch, tag, or commit).
     * @param {string} repo - 'owner/repo'
     * @param {string} ref - branch name, commit sha, or tag
     * @returns {Promise<Buffer>}
     */
    async downloadZipball(repo, ref = 'main') {
        const endpoint = `https://api.github.com/repos/${repo}/zipball/${encodeURIComponent(ref)}`;
        const res = await this.request(endpoint, {
            accept: 'application/vnd.github.v3+json',
            timeout: 60000
        });

        if (res.statusCode !== 200) {
            throw new Error(`Failed to download zipball (${res.statusCode}): ${res.data.toString()}`);
        }

        return res.data;
    }
}

module.exports = GitHubClient;
