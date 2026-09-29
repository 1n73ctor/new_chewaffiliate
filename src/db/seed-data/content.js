'use strict';
// Starter content. Every item is editable in Admin. Legal pages are DRAFTS
// for counsel to replace before launch.

const DRAFT = '> Draft for review by Chew Network management and counsel. Edit in Admin → Pages before launch.';

const pages = [
  {
    slug: 'terms',
    title: 'Terms of Use',
    body: `${DRAFT}

Welcome to the Chew Network affiliate website. By creating an account or using this site you agree to these Terms of Use.

# Your account
- You must provide accurate information and keep your password secure.
- One account per person. Accounts are personal and may not be sold or transferred.
- You are responsible for activity that happens under your account.

# Free to join
Joining the Chew Network Affiliate Program is free. No purchase is required to create an account, receive an Affiliate ID or use the back office.

# Acceptable use
Do not misuse the site, attempt to access other accounts, interfere with tracking, generate artificial clicks or sign-ups, or use automated tools to create activity.

# Content
Content Kitchen assets are licensed to you only for promoting Chew in line with the [Promotional Guidelines](/promotional-guidelines). Chew may update or withdraw assets at any time.

# Changes and termination
We may update these terms, and we may suspend or close accounts that break them. Continued use after changes means you accept the updated terms.

# Contact
Questions? Visit [Help & Support](/help).`,
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    body: `${DRAFT}

This policy explains what information the Chew Network affiliate website collects and how it is used.

# What we collect
- **Account details:** name, email, mobile number, country and password (stored as a secure hash).
- **Consents:** your separate choices for marketing emails and text messages, with the date you made them.
- **Agreement records:** the Affiliate Agreement version you accepted and when.
- **Tracking data:** clicks on affiliate links (time, link, campaign, content, source, destination), a first-party cookie used for attribution, and a one-way hash of the visitor IP address. We do not store raw IP addresses for link clicks.
- **App activity:** if you link the See It. Cook It. app, the app may report account-link and activation events to your Chew account.

# How we use it
To run your account, attribute referrals and qualifying activity to the right affiliate, calculate commissions from real tracked activity, provide support and keep the platform secure.

# Marketing and SMS
Marketing emails and text messages are optional and separate from your account terms. You can change either choice at any time in **Back Office → Account**. Verification and security messages are sent regardless because they are needed to operate your account.

# Cookies
We use essential cookies to keep you signed in and protect forms, and an attribution cookie that remembers which affiliate referred a visitor for a limited window.

# Your choices
You can update your details in the back office, or contact support to request access to or deletion of your data.

# Contact
[Help & Support](/help)`,
  },
  {
    slug: 'affiliate-agreement',
    title: 'Affiliate Agreement',
    body: `${DRAFT}

This Affiliate Agreement is between you and Chew Network (“Chew”). Please read it before creating your account.

# 1. The program
The Chew Network Affiliate Program lets you share Chew products, apps and content using links and tools provided in your back office.

# 2. Free to join
There is no fee to join, and no purchase is required — now or later — to participate or remain an affiliate.

# 3. Your Affiliate ID and links
After you accept this agreement you receive a unique Affiliate ID, a referral link and a QR code. Use only the links provided in your back office so activity can be tracked accurately.

# 4. How you promote Chew
- Follow the [Promotional Guidelines](/promotional-guidelines).
- Clearly disclose that you are a Chew affiliate when you share your links.
- Do not make income claims, guarantees or misleading statements.
- Do not spam, buy traffic that misrepresents Chew, or create artificial clicks or sign-ups.

# 5. Commissions and rewards
Commissions or rewards are earned only under the program rules published in your back office at the time the activity happens, and only for real, tracked qualifying activity. All activity is subject to review. Programs listed as Coming Soon, In Development or Partner Program are not active earning opportunities until they are marked Available Now.

# 6. No earnings guarantee
Chew does not guarantee any level of income. See the [Earnings Disclosure](/earnings-disclosure).

# 7. Independent participant
You are an independent participant, not an employee, agent or partner of Chew.

# 8. Ending the agreement
You may close your account at any time. Chew may suspend or close accounts that breach this agreement. Activity found to be fraudulent is not eligible for commissions.

# 9. Changes
Chew may update this agreement. We will tell you about material changes; the version you accepted is recorded on your account.

# 10. Contact
[Help & Support](/help)`,
  },
  {
    slug: 'promotional-guidelines',
    title: 'Promotional Guidelines',
    body: `${DRAFT}

Chew is a consumer technology platform. Promote it the way you would recommend any product you genuinely like.

# Do
- Use Content Kitchen assets and captions as provided, or write your own honest posts.
- Add a clear disclosure such as **#ad**, **#affiliate** or “I’m a Chew affiliate”.
- Use your tracked links and QR codes from the back office.
- Talk about what Chew does: See It. Cook It., recipes, food technology and the free affiliate program.
- Respect each platform’s rules.

# Don’t
- Don’t make income claims (“make $500 a week”) or imply earnings are guaranteed.
- Don’t describe Coming Soon or In Development programs as available now.
- Don’t say anyone must buy something to join — it’s free.
- Don’t spam, send unsolicited bulk messages, or text people who haven’t agreed to receive texts.
- Don’t create fake reviews, bots, or artificial clicks or sign-ups.
- Don’t alter Chew logos or pretend to be Chew staff.

# When in doubt
Ask support before you post.`,
  },
  {
    slug: 'earnings-disclosure',
    title: 'Earnings Disclosure',
    body: `${DRAFT}

Joining the Chew Network Affiliate Program is free and no purchase is required.

**Chew does not guarantee that you will earn any money.** Any commissions or rewards depend on the program rules in effect, real tracked qualifying activity, and review by Chew. Many affiliates earn nothing.

- Only pathways marked **Available Now** are active today. Others are planned or in development and may change or never launch.
- The back office shows only your real tracked clicks, referrals, qualifying activity and commission status — never examples or projections.
- Commission rules may change; the rules that apply are those in effect when the qualifying activity happened.

When sharing Chew, never make statements about income or earnings.`,
  },
];

const faqs = [
  ['Is it really free to join?', 'Yes. Joining is 100% free and no purchase is required — not to join and not to stay an affiliate.', 'Joining'],
  ['How long does it take to join?', 'About a minute: enter your details, confirm the code we send you, accept the Affiliate Agreement and you’re in.', 'Joining'],
  ['What is an Affiliate ID?', 'A unique ID created automatically when your account is ready. It powers your referral link and QR code so your activity is tracked to you.', 'Joining'],
  ['I didn’t get my verification code.', 'Check your spam folder, then use “Send a new code” on the verification page. If you added a mobile number you can choose to get the code by text instead. Still stuck? Contact support below.', 'Joining'],
  ['Where do I find my referral link and QR code?', 'On your back office Dashboard and on the My Links page. You can also create tracked links for specific channels and campaigns.', 'Back office'],
  ['What is the Content Kitchen?', 'Ready-to-share videos, images and captions made by Chew. Pick an asset, copy the caption, get your tracked link and post. Today’s 3 highlights fresh picks every day.', 'Back office'],
  ['What is See It. Cook It.?', 'Chew’s app: take a photo of food, get the recipe and watch it come to life. Download it from the App Store or Google Play and link it to your Chew account from the back office.', 'See It. Cook It.'],
  ['How do I link the app to my account?', 'In Back Office → See It. Cook It., generate a link code and enter it in the app (or sign in to the app with the same email). Your activation status updates automatically.', 'See It. Cook It.'],
  ['Which ways to earn are available now?', 'The 125+ Ways page labels every pathway: Available Now, Coming Soon, In Development or Partner Program. Only Available Now pathways are active today.', 'Earning'],
  ['How are commissions tracked?', 'Only from real tracked activity: clicks on your links, referred sign-ups and qualifying actions reported by Chew systems. Commissions go through review before approval.', 'Earning'],
  ['Am I guaranteed to earn money?', 'No. Chew does not guarantee any income. Please read the Earnings Disclosure.', 'Earning'],
  ['How do I change my email or close my account?', 'Contact support using the form on this page and we’ll help.', 'Account'],
];

const training = [
  {
    title: 'Getting Started',
    summary: 'Your first ten minutes as a Chew affiliate.',
    lessons: [
      ['Welcome to Chew Network', 'What Chew is and how the free affiliate program works.', 3, `Chew Network is a food technology platform. As an affiliate you share Chew apps, products and content using your own tracked links.

# What you get
- A unique **Affiliate ID**
- A referral link and **QR code**
- The **Content Kitchen** — ready-made posts
- **Training**, **analytics** and **commission tracking**

Joining is free and no purchase is ever required.`],
      ['Your Affiliate ID & referral link', 'Where to find your link and QR code and how tracking works.', 4, `Your Dashboard shows your Affiliate ID, your primary referral link and a QR code.

1. Tap **Copy** to copy your link.
2. Download the QR code for flyers, business cards or in-person sharing.
3. On **My Links**, create extra links for each channel (Instagram, WhatsApp, email…) so you can see which works best.

Every click records who shared it, what content, which source, which link and where it led.`],
      ['A quick tour of your back office', 'What each section of the back office is for.', 4, `- **Dashboard** — your ID, link, Today’s 3, progress and announcements
- **Content Kitchen** — posts to share
- **My Links** — tracked links and QR codes
- **Ways to Earn** — every pathway and its status
- **Analytics** — clicks, referrals and qualifying activity
- **Commissions** — your ledger and its status
- **Training** and **Resources** — learn and reference
- **See It. Cook It.** — download and activate the app
- **Account** — profile, password and communication choices`],
    ],
  },
  {
    title: 'See It. Cook It.',
    summary: 'Get the app, link it and show it to others.',
    lessons: [
      ['Download and link the app', 'Install See It. Cook It. and connect it to your Chew account.', 3, `1. Open **See It. Cook It.** in your back office.
2. Tap the App Store or Google Play button.
3. In the app, sign in with the same email or enter your **link code**.
4. Complete the in-app activation step — your back office updates automatically.`],
      ['Showing the app to friends', 'A simple, honest way to demo the app.', 3, `The best demo is a real one: point your camera at a dish, show the recipe appear, then play the cooking video.

Share your tracked **app link** from the See It. Cook It. page so downloads are attributed to you.`],
    ],
  },
  {
    title: 'Using the Content Kitchen',
    summary: 'We cook the content. You serve it.',
    lessons: [
      ['Today’s 3', 'Fresh picks, chosen daily.', 2, `Every day Chew picks three assets that are ready to post. Start there when you’re short on time.`],
      ['Copy caption & get your link', 'Post in under a minute.', 3, `1. Tap **Preview** to see the asset.
2. **Copy Caption** — paste it into your post.
3. **Get My Link** — a tracked link for that asset and channel.
4. **Download** the image or video and post it.

Usage status shows which assets you’ve already used.`],
      ['Posting best practices', 'Formats that work on each platform.', 4, `- **Instagram / TikTok / Shorts:** vertical video, hook in the first second, link in bio or story.
- **Facebook:** short caption, link in the post.
- **WhatsApp / Text:** personal message first, then the link — only to people who want to hear from you.
- Always add a disclosure such as **#ad** or **#affiliate**.`],
    ],
  },
  {
    title: 'Sharing the Right Way',
    summary: 'Stay compliant and keep trust.',
    lessons: [
      ['Promotional guidelines', 'What you can and can’t say.', 4, `Read the full [Promotional Guidelines](/promotional-guidelines). The short version: be honest, disclose that you’re an affiliate, and never make income claims.`],
      ['Earnings disclosure', 'Why we never talk about income.', 3, `Chew does not guarantee earnings, and only pathways marked **Available Now** are active. Read the [Earnings Disclosure](/earnings-disclosure).`],
    ],
  },
  {
    title: 'Tracking Your Progress',
    summary: 'Read your numbers.',
    lessons: [
      ['Reading your analytics', 'Clicks, sources, content and results.', 4, `**Analytics** shows real tracked activity only: clicks per day, which sources and content drove them, and what happened next (sign-ups, app activations, qualifying actions).

Clicks from link previews (bots) and your own clicks are excluded.`],
      ['How commissions are recorded', 'From qualifying activity to paid.', 3, `When a qualifying action matches an active commission rule, a **Pending** entry appears in your ledger. After review it moves to **Approved**, then **Paid** — or **Reversed** if the activity didn’t qualify.`],
    ],
  },
];

const resources = [
  ['Affiliate Agreement', 'The agreement every affiliate accepts when joining.', 'Program documents', '/affiliate-agreement', 'public'],
  ['Promotional Guidelines', 'How to share Chew honestly and compliantly.', 'Program documents', '/promotional-guidelines', 'public'],
  ['Earnings Disclosure', 'Chew does not guarantee earnings. Read why.', 'Program documents', '/earnings-disclosure', 'public'],
  ['How It Works', 'Join → get your ID → access your tools → learn → share → track.', 'Getting started', '/how-it-works', 'public'],
  ['Frequently asked questions', 'Answers to the most common questions.', 'Getting started', '/help', 'public'],
  ['125+ Ways to Participate', 'Every pathway and whether it is available now.', 'Getting started', '/ways-to-earn', 'public'],
  ['Disclosure examples', 'Copy-ready ways to say you’re an affiliate: “#ad”, “#affiliate”, “I’m a Chew affiliate”.', 'Sharing toolkit', '/promotional-guidelines', 'affiliate'],
  ['Training center', 'Step-by-step lessons for new affiliates.', 'Sharing toolkit', '/office/training', 'affiliate'],
];

const destinations = [
  ['home', 'Chew homepage', 'site', '/'],
  ['join', 'Join free page', 'site', '/join'],
  ['see-it-cook-it', 'See It. Cook It. page', 'site', '/see-it-cook-it'],
  ['app', 'See It. Cook It. download (detects device)', 'app', 'auto'],
  ['app-ios', 'See It. Cook It. — Apple App Store', 'app', 'ios'],
  ['app-android', 'See It. Cook It. — Google Play', 'app', 'android'],
  ['ways', '125+ Ways page', 'site', '/ways-to-earn'],
  ['how-it-works', 'How It Works page', 'site', '/how-it-works'],
];

const contentCategories = ['Recipes', 'Short Videos', 'See It. Cook It.', 'Chef Pepe', 'Join the Program', 'Tips & Quotes', 'Seasonal'];

const announcements = [
  {
    title: 'Welcome to the Chew Network Affiliate Program',
    body: 'Start with Today’s 3 in the Content Kitchen, download See It. Cook It., and complete the Getting Started lessons.',
    link_url: '/office/training',
    link_label: 'Start training',
    pinned: 1,
    published: 1,
  },
];

module.exports = { pages, faqs, training, resources, destinations, contentCategories, announcements };
