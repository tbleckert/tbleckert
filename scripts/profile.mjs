import { writeFile } from 'node:fs/promises';

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const user = process.env.PROFILE_USER || 'tbleckert';
const timezone = process.env.PROFILE_TIMEZONE || 'Europe/Stockholm';

if (!token) {
  throw new Error('Missing GH_TOKEN/GITHUB_TOKEN');
}

const now = new Date();

const daysAgo = days => {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
};

const start30 = daysAgo(29);
const start120 = daysAgo(119);
const start365 = daysAgo(364);

const previousEnd = new Date(start30);
previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);

const iso = date => date.toISOString();
const dateOnly = date => date.toISOString().slice(0, 10);

async function graphql(query, variables) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'tbleckert-developer-pulse',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub GraphQL returned ${response.status}: ${await response.text()}`,
    );
  }

  const json = await response.json();

  if (json.errors) {
    throw new Error(JSON.stringify(json.errors, null, 2));
  }

  return json.data;
}

const query = `
query ProfilePulse(
  $login: String!
  $from30: DateTime!
  $from120: DateTime!
  $previousEnd: DateTime!
  $from365: DateTime!
  $to: DateTime!
) {
  user(login: $login) {
    current: contributionsCollection(from: $from30, to: $to) {
      contributionCalendar {
        totalContributions

        weeks {
          contributionDays {
            date
            contributionCount
            weekday
          }
        }
      }

      commitContributionsByRepository(maxRepositories: 100) {
        contributions {
          totalCount
        }

        repository {
          nameWithOwner
          isPrivate

          primaryLanguage {
            name
            color
          }
        }
      }
    }

    previous: contributionsCollection(
      from: $from120
      to: $previousEnd
    ) {
      commitContributionsByRepository(maxRepositories: 100) {
        contributions {
          totalCount
        }

        repository {
          nameWithOwner
          isPrivate

          primaryLanguage {
            name
            color
          }
        }
      }
    }

    year: contributionsCollection(from: $from365, to: $to) {
      contributionCalendar {
        totalContributions

        weeks {
          contributionDays {
            date
            contributionCount
            weekday
          }
        }
      }
    }
  }
}
`;

const data = await graphql(query, {
  login: user,
  from30: iso(start30),
  from120: iso(start120),
  previousEnd: iso(previousEnd),
  from365: iso(start365),
  to: iso(now),
});

if (!data.user) {
  throw new Error(`GitHub user "${user}" not found`);
}

/**
 * Contribution data doesn't include commit timestamps, so use
 * commit search to build the "when I code" section.
 */
async function searchRecentCommits() {
  const commits = [];
  const since = dateOnly(start30);

  for (let page = 1; page <= 5; page++) {
    const query = encodeURIComponent(
      `author:${user} author-date:>=${since}`,
    );

    const url =
      `https://api.github.com/search/commits` +
      `?q=${query}` +
      `&sort=author-date` +
      `&order=desc` +
      `&per_page=100` +
      `&page=${page}`;

    const response = await fetch(url, {
      headers: {
        authorization: `bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tbleckert-developer-pulse',
      },
    });

    if (!response.ok) {
      console.warn(
        `Commit search unavailable (${response.status}). ` +
        `Time-of-day insights will be omitted.`,
      );

      return [];
    }

    const json = await response.json();

    commits.push(...json.items);

    if (json.items.length < 100) {
      break;
    }
  }

  return commits;
}

const commits = await searchRecentCommits();

const currentDays = data.user.current.contributionCalendar.weeks
  .flatMap(week => week.contributionDays)
  .filter(
    day =>
      day.date >= dateOnly(start30) &&
      day.date <= dateOnly(now),
  );

const yearDays = data.user.year.contributionCalendar.weeks
  .flatMap(week => week.contributionDays)
  .filter(
    day =>
      day.date >= dateOnly(start365) &&
      day.date <= dateOnly(now),
  );

const activeDays = currentDays.filter(
  day => day.contributionCount > 0,
).length;

function calculateStreak(days) {
  const sorted = [...days].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  let index = sorted.length - 1;

  // A zero-contribution "today" shouldn't immediately kill yesterday's streak.
  if (
    index >= 0 &&
    sorted[index].date === dateOnly(now) &&
    sorted[index].contributionCount === 0
  ) {
    index--;
  }

  let streak = 0;

  while (
    index >= 0 &&
    sorted[index].contributionCount > 0
  ) {
    streak++;
    index--;
  }

  return streak;
}

function weekdayStats(days) {
  const names = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];

  const counts = Array(7).fill(0);

  for (const day of days) {
    counts[day.weekday] += day.contributionCount;
  }

  const highest = Math.max(...counts);
  const index = counts.indexOf(highest);

  return {
    name: names[index],
    count: highest,
    counts,
  };
}

function languageStats(entries) {
  const languages = new Map();

  for (const item of entries) {
    const language = item.repository.primaryLanguage;

    if (!language) continue;

    const current = languages.get(language.name) || {
      name: language.name,
      color: language.color,
      count: 0,
    };

    current.count += item.contributions.totalCount;

    languages.set(language.name, current);
  }

  const rows = [...languages.values()].sort(
    (a, b) => b.count - a.count,
  );

  const total =
    rows.reduce((sum, row) => sum + row.count, 0) || 1;

  return rows.map(row => ({
    ...row,
    share: row.count / total,
  }));
}

const languages = languageStats(
  data.user.current.commitContributionsByRepository,
);

const previousLanguages = languageStats(
  data.user.previous.commitContributionsByRepository,
);

const previousShares = new Map(
  previousLanguages.map(language => [
    language.name,
    language.share,
  ]),
);

const obsession =
  languages
    .map(language => ({
      ...language,
      previousShare:
        previousShares.get(language.name) || 0,
      delta:
        language.share -
        (previousShares.get(language.name) || 0),
    }))
    .filter(
      language =>
        language.count >= 3 &&
        language.share >= 0.08,
    )
    .sort((a, b) => b.delta - a.delta)[0] ||
  languages[0] ||
  null;

function localHour(date) {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(date),
  );
}

const hours = Array(24).fill(0);

for (const item of commits) {
  const timestamp =
    item.commit?.author?.date ||
    item.commit?.committer?.date;

  if (!timestamp) continue;

  hours[localHour(new Date(timestamp))]++;
}

const totalHourlyCommits = hours.reduce(
  (sum, count) => sum + count,
  0,
);

const periods = [
  {
    key: 'morning',
    label: '06:00–12:00',
    hours: [6, 7, 8, 9, 10, 11],
  },
  {
    key: 'afternoon',
    label: '12:00–18:00',
    hours: [12, 13, 14, 15, 16, 17],
  },
  {
    key: 'evening',
    label: '18:00–00:00',
    hours: [18, 19, 20, 21, 22, 23],
  },
  {
    key: 'night',
    label: '00:00–06:00',
    hours: [0, 1, 2, 3, 4, 5],
  },
].map(period => ({
  ...period,
  count: period.hours.reduce(
    (sum, hour) => sum + hours[hour],
    0,
  ),
}));

const topPeriod = [...periods].sort(
  (a, b) => b.count - a.count,
)[0];

const periodPercent = totalHourlyCommits
  ? Math.round(
      (topPeriod.count / totalHourlyCommits) * 100,
    )
  : null;

const topHourCount = Math.max(...hours);
const topHour = topHourCount
  ? hours.indexOf(topHourCount)
  : null;

const weekday = weekdayStats(currentDays);
const streak = calculateStreak(yearDays);

const activeRepositories = new Set(
  commits
    .map(commit => commit.repository?.full_name)
    .filter(Boolean),
);

const privateRepositories = new Set(
  commits
    .filter(commit => commit.repository?.private)
    .map(commit => commit.repository.full_name),
);

const publicRepositories = new Set(
  commits
    .filter(
      commit =>
        commit.repository &&
        !commit.repository.private,
    )
    .map(commit => commit.repository.full_name),
);

function codingNarrative() {
  if (!totalHourlyCommits) {
    return {
      title: 'I build when the work clicks.',
      detail:
        'My coding rhythm updates here every day.',
    };
  }

  const titles = {
    morning: 'I am a morning developer.',
    afternoon: 'I do my best work in the afternoon.',
    evening: 'I am an evening developer.',
    night: 'I am a night owl.',
  };

  return {
    title: titles[topPeriod.key],
    detail:
      `${periodPercent}% of my recent commits land ` +
      `between ${topPeriod.label}.`,
  };
}

const narrative = codingNarrative();

const total30 =
  data.user.current.contributionCalendar
    .totalContributions;

const topLanguages = languages.slice(0, 5);

const maxCurrentDay = Math.max(
  1,
  ...currentDays.map(day => day.contributionCount),
);

const maxYearDay = Math.max(
  1,
  ...yearDays.map(day => day.contributionCount),
);

const escapeXml = value =>
  String(value ?? '').replace(
    /[&<>"]/g,
    character =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
      })[character],
  );

const percentage = number =>
  `${Math.round(number * 100)}%`;

const compact = number =>
  new Intl.NumberFormat('en', {
    notation: number >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(number);

function renderActivityBars() {
  const x = 74;
  const baseline = 608;
  const width = 1052;
  const gap = 5;

  const barWidth =
    (width - gap * (currentDays.length - 1)) /
    currentDays.length;

  return currentDays
    .map((day, index) => {
      const height = day.contributionCount
        ? 10 +
          (day.contributionCount / maxCurrentDay) *
            108
        : 3;

      const barX =
        x + index * (barWidth + gap);

      const barY = baseline - height;

      return `
        <rect
          class="bar"
          x="${barX.toFixed(1)}"
          y="${barY.toFixed(1)}"
          width="${barWidth.toFixed(1)}"
          height="${height.toFixed(1)}"
          rx="${Math.min(4, barWidth / 2).toFixed(1)}"
          opacity="${day.contributionCount ? 0.95 : 0.16}"
        />
      `;
    })
    .join('');
}

function renderLanguages() {
  if (!topLanguages.length) {
    return `
      <text class="muted small" x="74" y="780">
        Language data will appear after the next refresh.
      </text>
    `;
  }

  return topLanguages
    .map((language, index) => {
      const y = 770 + index * 62;
      const barWidth = Math.max(
        4,
        480 * language.share,
      );

      return `
        <text class="label fg" x="74" y="${y}">
          ${escapeXml(language.name)}
        </text>

        <text
          class="muted small"
          x="554"
          y="${y}"
          text-anchor="end"
        >
          ${percentage(language.share)}
        </text>

        <rect
          class="track"
          x="74"
          y="${y + 16}"
          width="480"
          height="8"
          rx="4"
        />

        <rect
          class="accent"
          x="74"
          y="${y + 16}"
          width="${barWidth.toFixed(1)}"
          height="8"
          rx="4"
        />
      `;
    })
    .join('');
}

function renderHeatmap() {
  const startX = 660;
  const startY = 790;
  const cell = 12;
  const gap = 5;

  const byDate = new Map(
    yearDays.map(day => [day.date, day]),
  );

  const firstDate = new Date(
    `${yearDays[0]?.date || dateOnly(start365)}T00:00:00Z`,
  );

  firstDate.setUTCDate(
    firstDate.getUTCDate() - firstDate.getUTCDay(),
  );

  const cells = [];

  for (let week = 0; week < 53; week++) {
    for (let day = 0; day < 7; day++) {
      const current = new Date(firstDate);

      current.setUTCDate(
        firstDate.getUTCDate() +
          week * 7 +
          day,
      );

      const contribution = byDate.get(
        dateOnly(current),
      );

      if (!contribution) continue;

      const opacity =
        contribution.contributionCount === 0
          ? 0.08
          : 0.25 +
            0.75 *
              (contribution.contributionCount /
                maxYearDay);

      cells.push(`
        <rect
          class="heat"
          x="${startX + week * (cell + gap)}"
          y="${startY + day * (cell + gap)}"
          width="${cell}"
          height="${cell}"
          rx="3"
          opacity="${opacity.toFixed(2)}"
        />
      `);
    }
  }

  return cells.join('');
}

const obsessionTitle = obsession
  ? `I’m currently into ${obsession.name}.`
  : 'I keep exploring.';

const obsessionDetail = obsession
  ? obsession.previousShare > 0
    ? `${percentage(
        obsession.share,
      )} of my recent commit activity is in ${
        obsession.name
      }, ${
        obsession.delta >= 0 ? 'up' : 'down'
      } ${Math.abs(
        Math.round(obsession.delta * 100),
      )} pts.`
    : `${percentage(
        obsession.share,
      )} of my recent commit activity is in ${
        obsession.name
      }.`
  : 'My language mix will show up here as I build.';

const repositoryCount =
  activeRepositories.size ||
  data.user.current
    .commitContributionsByRepository.length;

const repositoryDetail = activeRepositories.size
  ? `${activeRepositories.size} repositories active · ` +
    `${privateRepositories.size} private · ` +
    `${publicRepositories.size} public`
  : `${repositoryCount} repositories with commits`;

const busiestHourDetail =
  topHour !== null
    ? ` My busiest hour is around ${String(
        topHour,
      ).padStart(2, '0')}:00.`
    : '';

const svg = `<?xml version="1.0" encoding="UTF-8"?>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width="1200"
  height="1380"
  viewBox="0 0 1200 1380"
  role="img"
  aria-labelledby="title desc"
>
  <title id="title">
    Tobias Bleckert — Developer Pulse
  </title>

  <desc id="desc">
    A live GitHub activity profile generated from Tobias Bleckert's GitHub data.
  </desc>

  <style>
    :root {
      color-scheme: light dark;
    }

    .bg { fill: #ffffff; }
    .fg { fill: #111318; }
    .muted { fill: #667085; }
    .line { stroke: #e7e9ee; }
    .track { fill: #eef0f4; }

    .accent,
    .bar,
    .heat {
      fill: #111318;
    }

    text {
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Helvetica,
        Arial,
        sans-serif;
    }

    .kicker {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 2px;
    }

    .hero {
      font-size: 48px;
      font-weight: 700;
      letter-spacing: -1.8px;
    }

    .lede {
      font-size: 22px;
      font-weight: 450;
    }

    .big {
      font-size: 46px;
      font-weight: 680;
      letter-spacing: -1.3px;
    }

    .label {
      font-size: 18px;
      font-weight: 650;
    }

    .small {
      font-size: 15px;
    }

    .statement {
      font-size: 29px;
      font-weight: 690;
      letter-spacing: -0.7px;
    }

    .detail {
      font-size: 17px;
    }

    .tiny {
      font-size: 13px;
    }

    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; }
      .fg { fill: #f0f3f6; }
      .muted { fill: #8b949e; }
      .line { stroke: #2a3038; }
      .track { fill: #21262d; }

      .accent,
      .bar,
      .heat {
        fill: #f0f3f6;
      }
    }
  </style>

  <rect
    class="bg"
    width="1200"
    height="1380"
    rx="28"
  />

  <text
    class="fg kicker"
    x="74"
    y="84"
  >
    TOBIAS BLECKERT · DEVELOPER PULSE
  </text>

  <text
    class="fg hero"
    x="74"
    y="156"
  >
    Hi, I’m Tobias.
  </text>

  <text
    class="muted lede"
    x="74"
    y="198"
  >
    I build products for the web and iOS. This is what my GitHub looks like right now.
  </text>

  <line
    class="line"
    x1="74"
    y1="242"
    x2="1126"
    y2="242"
  />

  <text
    class="muted kicker"
    x="74"
    y="296"
  >
    THE LAST 30 DAYS
  </text>

  <text
    class="fg big"
    x="74"
    y="365"
  >
    ${compact(total30)}
  </text>

  <text
    class="muted label"
    x="74"
    y="395"
  >
    contributions
  </text>

  <text
    class="fg big"
    x="345"
    y="365"
  >
    ${activeDays}
  </text>

  <text
    class="muted label"
    x="345"
    y="395"
  >
    active days
  </text>

  <text
    class="fg big"
    x="610"
    y="365"
  >
    ${streak}
  </text>

  <text
    class="muted label"
    x="610"
    y="395"
  >
    day streak
  </text>

  <text
    class="fg big"
    x="870"
    y="365"
  >
    ${repositoryCount}
  </text>

  <text
    class="muted label"
    x="870"
    y="395"
  >
    active projects
  </text>

  ${renderActivityBars()}

  <text
    class="muted tiny"
    x="74"
    y="632"
  >
    ${escapeXml(
      currentDays[0]?.date ||
        dateOnly(start30),
    )}
  </text>

  <text
    class="muted tiny"
    x="1126"
    y="632"
    text-anchor="end"
  >
    ${escapeXml(
      currentDays.at(-1)?.date ||
        dateOnly(now),
    )}
  </text>

  <line
    class="line"
    x1="74"
    y1="676"
    x2="1126"
    y2="676"
  />

  <text
    class="muted kicker"
    x="74"
    y="728"
  >
    WHERE I’M CODING
  </text>

  ${renderLanguages()}

  <text
    class="muted kicker"
    x="660"
    y="728"
  >
    MY YEAR IN MOTION
  </text>

  ${renderHeatmap()}

  <text
    class="muted small"
    x="660"
    y="936"
  >
    ${compact(
      data.user.year.contributionCalendar
        .totalContributions,
    )} contributions over the last 12 months
  </text>

  <line
    class="line"
    x1="74"
    y1="1020"
    x2="1126"
    y2="1020"
  />

  <text
    class="muted kicker"
    x="74"
    y="1072"
  >
    HOW I WORK
  </text>

  <text
    class="fg statement"
    x="74"
    y="1122"
  >
    ${escapeXml(narrative.title)}
  </text>

  <text
    class="muted detail"
    x="74"
    y="1153"
  >
    ${escapeXml(
      narrative.detail +
        busiestHourDetail,
    )}
  </text>

  <text
    class="fg statement"
    x="74"
    y="1218"
  >
    ${escapeXml(obsessionTitle)}
  </text>

  <text
    class="muted detail"
    x="74"
    y="1249"
  >
    ${escapeXml(obsessionDetail)}
  </text>

  <text
    class="fg statement"
    x="74"
    y="1314"
  >
    ${escapeXml(
      `${weekday.name} is my busiest day.`,
    )}
  </text>

  <text
    class="muted detail"
    x="74"
    y="1345"
  >
    ${escapeXml(repositoryDetail)} · refreshed daily from GitHub
  </text>
</svg>`;

const stats = {
  generatedAt: now.toISOString(),
  user,
  timezone,

  last30Days: {
    contributions: total30,
    activeDays,
    streak,
    activeRepositories:
      activeRepositories.size,
    privateRepositories:
      privateRepositories.size,
    publicRepositories:
      publicRepositories.size,
  },

  rhythm: {
    topPeriod: topPeriod?.key || null,
    periodPercent,
    topHour,
    weekday: weekday.name,
    searchedCommits: commits.length,
  },

  languages: languages.map(
    ({ name, count, share }) => ({
      name,
      count,
      share: Number(share.toFixed(4)),
    }),
  ),

  obsession: obsession
    ? {
        language: obsession.name,
        share: Number(
          obsession.share.toFixed(4),
        ),
        previousShare: Number(
          obsession.previousShare.toFixed(4),
        ),
        delta: Number(
          obsession.delta.toFixed(4),
        ),
      }
    : null,

  year: {
    contributions:
      data.user.year.contributionCalendar
        .totalContributions,
  },
};

await Promise.all([
  writeFile('profile.svg', svg),
  writeFile(
    'stats.json',
    JSON.stringify(stats, null, 2) + '\n',
  ),
]);

console.log(
  `Generated Developer Pulse for ${user}: ` +
    `${total30} contributions, ` +
    `${activeDays} active days, ` +
    `${commits.length} commits sampled.`,
);
