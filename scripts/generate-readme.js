const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const StreamArray = require('stream-json/streamers/StreamArray');

const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
// Use the raw URL for the enriched users file (large). We'll stream it.
const USERS_JSON_URL = 'https://raw.githubusercontent.com/sharf-shawon/Awesome-Bangladeshi-Devs/main/data/users-enriched.json';

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
  return response.json();
}

/**
 * Stream and extract github_username values from a (potentially huge) JSON array.
 * Uses stream-json to avoid loading the full file into memory.
 */
async function fetchUsernames(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);

  const usernames = [];

  await new Promise((resolve, reject) => {
    const parser = StreamArray.withParser();

    parser.on('data', ({ value }) => {
      if (value && value.github_username) usernames.push(value.github_username);
    });
    parser.on('end', resolve);
    parser.on('error', reject);

    pipeline(response.body, parser, err => {
      if (err) reject(err);
    });
  });

  return usernames;
}

/**
 * Stream and extract a minimal user record set from the enriched JSON.
 * Writes a lightweight JSON array to `outPath` as it parses to avoid memory pressure.
 * Returns an object map keyed by username with the extracted fields.
 */
async function extractUsersLite(url, outPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);

  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  const outStream = fs.createWriteStream(outPath, { encoding: 'utf8' });
  outStream.write('[');
  let first = true;

  const usersMap = {};

  await new Promise((resolve, reject) => {
    const parser = StreamArray.withParser();

    parser.on('data', ({ value }) => {
      if (!value || !value.github_username) return;
      const u = value.github_username;
      const item = {
        username: u,
        profile_url: value.profile_url || `https://github.com/${u}`,
        avatar_url: value.avatar_url || `https://avatars.githubusercontent.com/${u}`,
        website_url: value.website_url || null,
        top_language: value.top_language || null,
        all_languages: value.all_languages || [],
        total_stars: value.total_stars || 0,
        topics: (value.top_repos && value.top_repos[0] && value.top_repos[0].topics) || []
      };

      usersMap[u] = item;

      const chunk = (first ? '\n' : ',\n') + JSON.stringify(item);
      first = false;
      outStream.write(chunk);
    });

    parser.on('end', () => {
      outStream.write('\n]');
      outStream.end();
      resolve();
    });
    parser.on('error', err => reject(err));

    pipeline(response.body, parser, err => {
      if (err) reject(err);
    });
  });

  return usersMap;
}

/**
 * Fetches repository info using GraphQL for efficiency (100 repos per request)
 */
async function getPortfoliosGraphQL(usernames) {
  const query = `
    query {
      ${usernames.map((u, i) => `
        repo${i}: repository(owner: "${u}", name: "${u}") {
          name
          description
          stargazerCount
          forkCount
          url
          owner {
            login
          }
        }
      `).join('\n')}
    }
  `;

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(`GraphQL Error: ${JSON.stringify(result.errors)}`);
  }

  return Object.values(result.data || {})
    .filter(repo => repo !== null)
    .map(repo => ({
      username: repo.owner.login,
      repoName: repo.name,
      description: repo.description,
      stars: repo.stargazerCount,
      forks: repo.forkCount,
      repoUrl: repo.url,
      websiteUrl: repo.homepage || null
    }));
}

/**
 * Fallback to REST API if no token or for individual checks
 */
async function getRepoInfoREST(username) {
  const url = `https://api.github.com/repos/${username}/${username}`;
  const headers = GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {};

  const response = await fetch(url, { headers });
  if (response.status === 404) return null;
  if (!response.ok) {
    console.error(`\nError fetching ${username}: ${response.statusText}`);
    return null;
  }
  const repo = await response.json();
  return {
    username: repo.owner.login,
    description: repo.description,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    repoUrl: repo.html_url,
    websiteUrl: repo.homepage || null
  };
}

function cleanDescription(desc, repoUrl) {
  if (!desc) return 'Profile portfolio.';
  let cleaned = desc.trim();
  
  // Replace smart quotes to avoid match-punctuation issues
  cleaned = cleaned.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');

  // Remove the repo URL from description if it's there to avoid double-link
  if (repoUrl) {
    const escapedUrl = repoUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(escapedUrl, 'gi'), '').trim();
    const repoUrlNoSlash = repoUrl.replace(/\/$/, '');
    const escapedUrlNoSlash = repoUrlNoSlash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(escapedUrlNoSlash, 'gi'), '').trim();
  }

  // Remove starting non-alphanumeric characters (emojis, dashes, dots, etc.)
  // The linter requires descriptions to start with a valid uppercase letter.
  cleaned = cleaned.replace(/^[^a-zA-Z0-9]+/, '').trim();

  if (cleaned.length === 0) return 'Profile portfolio.';

  // Start with uppercase
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  
  // Replace GitHub variations globally
  cleaned = cleaned.replace(/github/gi, 'GitHub');
  
  // Fix repeated punctuation and spacing
  cleaned = cleaned.replace(/\.\.+/g, '.'); 
  cleaned = cleaned.replace(/\s+\./g, '.');
  
  // End with a period
  if (!/[.!?]$/.test(cleaned)) {
    cleaned += '.';
  }
  
  return cleaned;
}

async function main() {
  try {
    console.log('🚀 Fetching users from source (streaming enriched extract)...');
    const usersLitePath = path.join(__dirname, '../data/users-lite.json');
    const usersMap = await extractUsersLite(USERS_JSON_URL, usersLitePath);
    const usernames = Object.keys(usersMap);
    console.log(`✅ Extracted ${usernames.length} users (wrote ${usersLitePath}).`);

    let portfolios = [];

    if (GITHUB_TOKEN) {
      console.log('⚡ Using GitHub GraphQL API (Batch processing)...');
      for (let i = 0; i < usernames.length; i += 100) {
        const batch = usernames.slice(i, i + 100);
        process.stdout.write(`Processing batch ${Math.floor(i / 100) + 1}/${Math.ceil(usernames.length / 100)}... `);
        try {
          const results = await getPortfoliosGraphQL(batch);
          portfolios.push(...results);
          console.log(`Found ${results.length} portfolios.`);
        } catch (e) {
          console.error(`Batch failed, skipping: ${e.message}`);
        }
      }
    } else {
      console.log('⚠️ No GITHUB_TOKEN found. Using REST API (Sequential, slow due to rate limits)...');
      for (let i = 0; i < usernames.length; i++) {
        const username = usernames[i];
        process.stdout.write(`[${i + 1}/${usernames.length}] Checking ${username}... `);
        const repo = await getRepoInfoREST(username);
        if (repo) {
          portfolios.push(repo);
          console.log('Found!');
        } else {
          console.log('Not found.');
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    console.log(`\n✨ Found a total of ${portfolios.length} portfolios.`);
    portfolios.sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));

    // Enrich portfolios with lite user info (avatar, languages, topics)
    portfolios = portfolios.map(p => {
      const u = usersMap[p.username] || {};
      return Object.assign({}, p, {
        avatar: u.avatar_url || `https://avatars.githubusercontent.com/${p.username}`,
        profile_url: u.profile_url || `https://github.com/${p.username}`,
        website_url: u.website_url || p.websiteUrl || p.website_url || null,
        top_language: u.top_language || null,
        all_languages: u.all_languages || [],
        topics: u.topics || [],
        total_stars: u.total_stars || 0
      });
    });

    // Write data file required by request
    const dataDir = path.join(__dirname, '../data');
    const dataPath = path.join(dataDir, 'portfolios.json');
    await fs.promises.mkdir(dataDir, { recursive: true });
    fs.writeFileSync(dataPath, JSON.stringify(portfolios, null, 2), 'utf8');
    console.log(`✅ Wrote portfolio data to ${dataPath}`);

    // Also write a copy into docs for GitHub Pages serving from docs/
    const docsDataDir = path.join(__dirname, '../docs/data');
    await fs.promises.mkdir(docsDataDir, { recursive: true });
    const docsDataPath = path.join(docsDataDir, 'portfolios.json');
    fs.writeFileSync(docsDataPath, JSON.stringify(portfolios, null, 2), 'utf8');
    console.log(`✅ Wrote portfolio data to ${docsDataPath}`);

    const listContent = portfolios.map(p => {
      const desc = cleanDescription(p.description, p.repoUrl);
      return `- [${p.username}](${p.repoUrl}) - Stars ${p.stars} / Forks ${p.forks}.`;
    }).join('\n');

    const readmePath = path.join(__dirname, '../README.md');
    let readme = fs.readFileSync(readmePath, 'utf8');

    const startTag = '<!-- PORTFOLIO-LIST:START -->';
    const endTag = '<!-- PORTFOLIO-LIST:END -->';

    const regex = new RegExp(`${startTag}[\\s\\S]*${endTag}`);
    readme = readme.replace(regex, `${startTag}\n\n${listContent}\n\n${endTag}`);

    fs.writeFileSync(readmePath, readme);
    console.log('✅ README.md updated successfully!');

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

main();
