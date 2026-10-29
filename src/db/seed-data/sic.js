'use strict';
// See It. Cook It. wholesale program: starting content. Inserted once (see seed.js
// ensureSicData); everything here is editable in the admin afterwards.
// {{sic_…}} placeholders are filled from Settings when shown, so prices stay current.

const packages = [
  {
    name: 'Wholesale Starter Package',
    description: 'Promotional credits you give to creators for free. Credits can’t be resold.',
    price_cents: 50000,
    credits: 3500,
  },
];

const destinations = [
  ['wholesale', 'Wholesale affiliate information page', 'site', '/wholesale'],
  ['claim', 'Free-credit claim page (claim links only)', 'site', '/claim'],
];

const pages = [
  {
    slug: 'wholesale-terms',
    title: 'See It. Cook It. Wholesale Terms',
    body: `These terms apply to Chew Network affiliates who buy See It. Cook It. promotional credits ("wholesale affiliates"). They add to the [Affiliate Agreement](/affiliate-agreement). Joining the Chew Network Affiliate Program stays free; the wholesale program is a separate, optional paid offering.

# Credits are promotional
- Credits are bought in packages and **given to creators for free**. They have no cash value and **can’t be resold, exchanged or refunded to creators**.
- Generating a video uses credits ({{sic_video_cost}} credits per completed video under current settings). Chew may change credit settings and package prices; changes apply to future purchases and grants.
- Never describe free credits as a cash prize, and never charge anyone for them.

# Attribution policy
- **One creator, one wholesale affiliate.** A creator is assigned to the first wholesale affiliate whose free credits they redeem in the app (or whose referral the app records first). The assignment lasts for the life of the app.
- A creator can claim sponsored credits once. Extra claims are released back to the sponsoring affiliate’s inventory.
- New credits can be given to a creator once their previous grant is used, unless Chew approves an exception.
- Unredeemed claims expire after {{sic_claim_expiry_days}} days and their credits return to your inventory.
- Disputes are reviewed by Chew. Chew may reassign a creator after review; every change is recorded.

# Earnings
- Eligible earnings depend on attributed customer activity (such as subscriptions and watermark-free downloads) and the commission schedule in your signed agreement. Earnings are not guaranteed — see the [Earnings Disclosure](/earnings-disclosure).
- Refunds, chargebacks and fraud reverse the related earnings. Payouts are made on approved earnings above the payout minimum ({{sic_payout_threshold}}).

# Privacy
- You see masked creator IDs and activity only — never creators’ names, emails or payment details.`,
  },
  {
    slug: 'giveaway-guidelines',
    title: 'Credit Giveaway Guidelines',
    body: `How to advertise See It. Cook It. free-credit giveaways honestly. Read with the [Promotional Guidelines](/promotional-guidelines).

# Do
- Say the credits are **free** and sponsored, and that each video uses credits.
- Say videos take a little time to create.
- Mention that watermark-free downloads cost {{sic_price_download}} without a subscription, or come with a subscription ({{sic_price_monthly}} or {{sic_price_annual}}).
- Add a disclosure such as **#ad** or **#sponsored**.
- Use your tracked claim link so creators are attributed to you.

# Don’t
- Don’t call credits a cash prize, a payment or something with cash value.
- Don’t sell, trade or charge for credits.
- Don’t promise income, instant rendering, unlimited videos or results.
- Don’t create fake accounts or claim credits for yourself.
- Don’t share creators’ personal information.`,
  },
];

const trainingModules = [
  {
    title: 'For Creators',
    track: 'creators',
    summary: 'Share these steps with the creators you invite: from free credits to a finished cooking video.',
    lessons: [
      ['Claim your free credits', 'Open the claim link, enter your email, then sign in to the app.', 2, 0, `1. Open the free-credit link you were sent.
2. Enter your email and accept the terms.
3. Download **See It. Cook It.** and sign in with the **same email** — or enter the claim code from the page.
4. Your credits appear in the app once you sign in.

# FAQ
**Do I pay for the credits?** No. They’re sponsored and free.
**How long do I have?** Sign in within {{sic_claim_expiry_days}} days or the claim expires.`],
      ['Upload a dish', 'Pick a clear photo of the food you want to cook.', 2, 0, `- Use a bright, sharp photo where the dish fills most of the frame.
- One dish per photo works best.
- You can take a new photo or choose one from your gallery.`],
      ['Choose yourself or an AI chef, and a kitchen', 'Pick who cooks and where.', 2, 0, `- **Your face:** follow the in-app steps to use your own likeness.
- **AI chef:** pick one of the available chefs.
- **Kitchen:** choose the setting for your video.`],
      ['Generate your video', 'Create the cooking video — it takes a little time.', 2, 0, `Tap **Create video**. Each completed video uses **{{sic_video_cost}} credits**. Videos take some time to create; the app lets you know when yours is ready.

If a video fails, the credits are returned automatically.`],
      ['Watermark, downloads and subscriptions', 'What’s free, what costs money and why.', 3, 0, `- Videos made with free credits include **Chew branding (watermark)**.
- A single **watermark-free download** costs **{{sic_price_download}}** without a subscription.
- A **subscription** ({{sic_price_monthly}} or {{sic_price_annual}}) includes watermark-free downloads.
- {{sic_fair_use}}`],
      ['Creator demo (60–90 seconds)', 'A short walkthrough video of the whole flow.', 2, 1, `This demo video is being produced.`],
    ],
  },
  {
    title: 'For Wholesale Affiliates',
    track: 'wholesale',
    summary: 'Give away credits, grow your audience and read your results.',
    lessons: [
      ['Find your tracked links', 'Claim links, the app page and the wholesale page.', 3, 0, `- **Claim links** (See It. Cook It. → Issue free credits) give creators free credits and assign them to you.
- **My Links → See It. Cook It. promo links** has tracked links and QR codes for the app page and the wholesale information page.
- Use **Test link** to check where a link goes and what it records — without counting a click.`],
      ['Advertise your giveaway', 'Honest, compliant giveaway posts.', 4, 0, `Start from the **giveaway templates** in Resources and the **ready-to-use ads** in the Content Kitchen.

- Say the credits are free and that videos use credits.
- Add **#ad** or **#sponsored**.
- Never call credits a cash prize or promise results.

Read the [Credit Giveaway Guidelines](/giveaway-guidelines).`],
      ['Allocate credits', 'Claim links and direct grants, step by step.', 4, 0, `**Claim link:** choose credits per creator (in whole videos) and how many creators can claim. Credits are reserved when someone claims and released if they don’t sign in to the app within {{sic_claim_expiry_days}} days.

**Direct grant:** pick one of your assigned creators, choose an approved amount, check your balance, confirm. A creator can get new credits once their previous grant is used.

Every grant is logged permanently with its own reference.`],
      ['Understand attribution', 'One creator, one wholesale affiliate.', 3, 0, `A creator is assigned to the **first** wholesale affiliate whose credits they redeem in the app. That lasts for the life of the app. If they already belong to someone else, your claim is released back to your inventory and shows as an *attribution exception*.

See the [Wholesale Terms](/wholesale-terms).`],
      ['Read your analytics and commissions', 'Your users, credits and eligible earnings.', 4, 0, `- **Analytics → My See It. Cook It. users**: masked creator IDs, credits granted, used and remaining, subscription status and activity.
- **Commissions → See It. Cook It.**: each eligible payment, how the amount was calculated, its status and any refund adjustment.

Earnings depend on real customer activity and your signed terms; they’re never guaranteed.`],
      ['Wholesale walkthrough (60–90 seconds)', 'A short video tour of the command center.', 2, 1, `This walkthrough video is being produced.`],
    ],
  },
];

const resources = [
  ['See It. Cook It. Wholesale Terms', 'Credits, attribution policy and earnings for wholesale affiliates.', 'See It. Cook It. toolkit', '/wholesale-terms', 'affiliate'],
  ['Credit Giveaway Guidelines (do & don’t)', 'How to advertise free credits honestly.', 'See It. Cook It. toolkit', '/giveaway-guidelines', 'affiliate'],
  ['Short-form video examples', 'Approved See It. Cook It. videos with captions, ready to share.', 'See It. Cook It. toolkit', '/office/content-kitchen?category=see-it-cook-it', 'affiliate'],
  ['Brand assets', 'Logos, app screens and approved images in the Content Kitchen.', 'See It. Cook It. toolkit', '/office/content-kitchen?category=see-it-cook-it', 'affiliate'],
];

// kind: ad | giveaway | creator_faq. {link} becomes the affiliate's tracked link.
const promoCopy = [
  ['ad', 'Food creators', 'Turn a photo into a cooking video', `Got a dish you love? Turn the photo into a cooking video with See It. Cook It. — choose yourself or an AI chef and pick a kitchen. Free sponsored credits to start 👉 {link} #ad`, 'Pair with a See It. Cook It. sample video.'],
  ['ad', 'Food creators', 'More cooking content, less filming', `Make cooking videos from your food photos — no kitchen shoot needed. Each video uses credits; grab free sponsored credits here 👉 {link} #sponsored`, 'Don’t promise instant results — videos take a little time.'],
  ['ad', 'Home cooks', 'See your dinner come to life', `Snap tonight’s dinner and watch it become a cooking video you can share with family. Free credits to try it 👉 {link} #ad`, null],
  ['ad', 'Influencers', 'A new format for your food feed', `Upload a dish, pick an AI chef or yourself, choose a kitchen — See It. Cook It. creates the video. Free sponsored credits for my followers 👉 {link} #ad`, 'Disclose the sponsorship clearly in the caption.'],
  ['ad', 'Restaurants', 'Show your signature dish being cooked', `Turn photos of your signature dishes into cooking videos for your socials with See It. Cook It. Start with free sponsored credits 👉 {link} #sponsored`, 'Only use photos of dishes you own the rights to.'],
  ['giveaway', null, 'Simple giveaway post', `🎁 Free See It. Cook It. credits! Turn a food photo into a cooking video. Claim yours (free, while they last) 👉 {link}\nEach video uses credits. Videos made with free credits include Chew branding. #ad`, 'Post with a sample video. Credits are free — never call them a prize with cash value.'],
  ['giveaway', null, 'Story / short caption', `Free credits to make your first AI cooking video 🍳 Link 👉 {link} #sponsored`, null],
  ['giveaway', null, 'Direct message', `Hi! I have free sponsored credits for See It. Cook It. — it turns a food photo into a cooking video. Want some? Claim here: {link} (sign in to the app with the same email). #ad`, 'Only message people who want to hear from you.'],
  ['creator_faq', null, 'Are the credits really free?', `Yes. They’re sponsored credits — you don’t pay for them.`, null],
  ['creator_faq', null, 'How many credits does a video use?', `Each completed video uses {{sic_video_cost}} credits. If a video fails, the credits are returned.`, null],
  ['creator_faq', null, 'Why does my video have a watermark?', `Videos made without a subscription include Chew branding. A watermark-free download costs {{sic_price_download}}, or subscribe for {{sic_price_monthly}} or {{sic_price_annual}}.`, null],
  ['creator_faq', null, 'How long does a video take?', `It takes a little time to create — the app tells you when it’s ready.`, null],
  ['creator_faq', null, 'My credits didn’t show up.', `Sign in to the app with the same email you used to claim, or enter the claim code from the claim page. Claims expire after {{sic_claim_expiry_days}} days.`, null],
  ['creator_faq', null, 'Can I claim free credits twice?', `Sponsored credits can be claimed once per person.`, null],
];

module.exports = { packages, destinations, pages, trainingModules, resources, promoCopy };
