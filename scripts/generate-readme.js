const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const USERS_JSON_URL = 'https://raw.githubusercontent.com/sharf-shawon/Awesome-Bangladeshi-Devs/main/data/users.json';

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
  return response.json();
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
      repoUrl: repo.url
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
    repoUrl: repo.html_url
  };
}

function cleanDescription(desc) {
  if (!desc) return 'Profile portfolio.';
  let cleaned = desc.trim();
  if (cleaned.length === 0) return 'Profile portfolio.';
  
  // Start with uppercase
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  
  // End with a period
  if (!/[.!?]$/.test(cleaned)) {
    cleaned += '.';
  }
  
  // Replace Github with GitHub
  cleaned = cleaned.replace(/Github/g, 'GitHub').replace(/github/g, 'GitHub');
  
  return cleaned;
}

async function main() {
  try {
    console.log('🚀 Fetching users from source...');
    const users = await fetchJson(USERS_JSON_URL);
    const usernames = users.map(u => u.github_username);
    console.log(`✅ Found ${usernames.length} users.`);

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

    const listContent = portfolios.map(p => {
      const desc = cleanDescription(p.description);
      return `- [${p.username}](${p.repoUrl}) - ${desc} (★ ${p.stars} / 🍴 ${p.forks})`;
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
