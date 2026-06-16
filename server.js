import express from "express";
import cors from "cors";
import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

/* ─── CORS ────────────────────────────────────────────────────────────────── */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

/* ─── SUPABASE ────────────────────────────────────────────────────────────── */
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

/* ─── GMAIL API OAUTH ─────────────────────────────────────────────────────── */
let oauth2Client = null;
let gmailCredentials = null;

function initGmailOAuth() {
  try {
    const credentials = JSON.parse(process.env.GMAIL_OAUTH_CREDENTIALS);
    
    // Handle both "web" (Web application) and "installed" (Desktop app) formats
    const config = credentials.web || credentials.installed;
    
    if (!config) {
      throw new Error("Invalid credentials format - missing 'web' or 'installed' key");
    }

    const { client_id, client_secret, redirect_uris } = config;
    
    oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0] || "http://localhost:5000/auth/google/callback"
    );
    
    console.log("✓ Gmail OAuth2 client initialized");
  } catch (err) {
    console.error("❌ Failed to initialize Gmail OAuth:", err.message);
  }
}

initGmailOAuth();

/* ─── SEND EMAIL VIA GMAIL API ────────────────────────────────────────────── */
const sendEmailViaGmail = async (gmailAccount, recipient, subject, body) => {
  try {
    // Get stored refresh token for this Gmail account
    const { data: accountData } = await supabase
      .from("accounts")
      .select("appPassword")
      .eq("email", gmailAccount.email)
      .single();

    if (!accountData || !accountData.appPassword) {
      throw new Error(`No refresh token stored for ${gmailAccount.email}`);
    }

    const refreshToken = accountData.appPassword;

    // Set refresh token and get new access token
    oauth2Client.setCredentials({
      refresh_token: refreshToken
    });

    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);

    // Create Gmail API instance
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Create email message
    const message = `From: ${gmailAccount.email}\r\nTo: ${recipient}\r\nSubject: ${subject}\r\n\r\n${body}`;
    const encodedMessage = Buffer.from(message).toString("base64").replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    // Send email
    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodedMessage
      }
    });

    return true;
  } catch (err) {
    console.log(`Failed to send to ${recipient}: ${err.message}`);
    return false;
  }
};

/* ─── INTERPOLATE TEMPLATE ────────────────────────────────────────────────── */
const interpolate = (template, lead) => {
  if (!template) return "";
  return template
    .replace(/\{\{firstName\}\}/g, lead.firstName || "")
    .replace(/\{\{lastName\}\}/g, lead.lastName || "")
    .replace(/\{\{company\}\}/g, lead.company || "")
    .replace(/\{\{email\}\}/g, lead.email || "")
    .replace(/\{\{iceBreaker\}\}/g, lead.iceBreaker || "");
};

/* ─── HEALTH CHECK ────────────────────────────────────────────────────────── */
app.get("/", (req, res) => {
  res.json({ status: "ColdReach Backend Running", time: new Date().toISOString() });
});

/* ─── PRIVACY POLICY ──────────────────────────────────────────────────────── */
app.get("/privacy", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Privacy Policy - ColdReach</title></head>
    <body style="max-width:800px;margin:40px auto;font-family:sans-serif;line-height:1.6">
      <h1>Privacy Policy</h1>
      <p><strong>Last Updated:</strong> June 2026</p>
      <h2>Information We Collect</h2>
      <p>ColdReach collects email addresses and campaign data to enable cold email automation.</p>
      <h2>How We Use Your Data</h2>
      <p>We use Gmail API access only to send emails on your behalf. We do not store email contents or access your inbox.</p>
      <h2>Data Security</h2>
      <p>All data is stored securely in Supabase PostgreSQL with encryption at rest.</p>
      <h2>Third-Party Services</h2>
      <p>We use Google Gmail API and Supabase. See their privacy policies for more info.</p>
      <h2>Contact</h2>
      <p>Email: frdhdu55@gmail.com</p>
    </body>
    </html>
  `);
});

/* ─── TERMS OF SERVICE ────────────────────────────────────────────────────── */
app.get("/terms", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Terms of Service - ColdReach</title></head>
    <body style="max-width:800px;margin:40px auto;font-family:sans-serif;line-height:1.6">
      <h1>Terms of Service</h1>
      <p><strong>Last Updated:</strong> June 2026</p>
      <h2>Use License</h2>
      <p>ColdReach is provided as-is for email automation purposes.</p>
      <h2>Disclaimer</h2>
      <p>Users are responsible for complying with anti-spam laws (CAN-SPAM, GDPR, etc.). ColdReach is not liable for misuse.</p>
      <h2>Limitations</h2>
      <p>We reserve the right to suspend accounts that violate our policies or applicable law.</p>
      <h2>Changes to Terms</h2>
      <p>We may update these terms at any time.</p>
      <h2>Contact</h2>
      <p>Email: frdhdu55@gmail.com</p>
    </body>
    </html>
  `);
});

/* ─── OAUTH: GET AUTHORIZATION URL ────────────────────────────────────────── */
app.get("/auth/google", (req, res) => {
  try {
    if (!oauth2Client) {
      return res.status(500).json({ error: "OAuth2 client not initialized" });
    }

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/gmail.send"],
    });

    res.json({ authUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── OAUTH: CALLBACK (GOOGLE REDIRECTS HERE) ────────────────────────────── */
app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;

    if (!code) {
      return res.status(400).json({ error: "Missing authorization code" });
    }

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;
    const accessToken = tokens.access_token;

    if (!refreshToken) {
      return res.status(400).json({ error: "Failed to get refresh token. Make sure to select 'Offline access' during authorization." });
    }

    // Get user's email from Google API
    oauth2Client.setCredentials({ access_token: accessToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress;

    if (!email) {
      return res.status(400).json({ error: "Could not retrieve email from Google account" });
    }

    // Store refresh token in database
    const { data: existingAccount } = await supabase
      .from("accounts")
      .select("id")
      .eq("email", email)
      .single();

    if (existingAccount) {
      // Update existing account
      await supabase
        .from("accounts")
        .update({ appPassword: refreshToken })
        .eq("id", existingAccount.id);
    } else {
      // Create new account
      await supabase
        .from("accounts")
        .insert([{
          email,
          label: email,
          limit: 100,
          appPassword: refreshToken,
          active: true,
          sentToday: 0,
          createdAt: new Date().toISOString(),
        }]);
    }

    res.json({
      success: true,
      message: `Gmail account ${email} authorized successfully!`,
      email: email
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
/* ─── GET ALL CAMPAIGNS ───────────────────────────────────────────────────── */
app.get("/api/campaigns", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("campaigns")
      .select("*")
      .order("createdAt", { ascending: false });

    if (error) throw error;

    const campaignsWithLeads = await Promise.all(
      data.map(async (c) => {
        const { data: leads } = await supabase
          .from("leads")
          .select("*")
          .eq("campaignId", c.id);
        return { ...c, leads: leads || [] };
      })
    );

    res.json(campaignsWithLeads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── CREATE CAMPAIGN ─────────────────────────────────────────────────────── */
app.post("/api/campaigns", async (req, res) => {
  try {
    const { name, sequence } = req.body;
    const { data, error } = await supabase
      .from("campaigns")
      .insert([{
        name,
        status: "draft",
        sequence: sequence || [],
        schedule: null,
        createdAt: new Date().toISOString(),
      }])
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── UPDATE CAMPAIGN ─────────────────────────────────────────────────────── */
app.put("/api/campaigns/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, status, sequence, schedule, leads } = req.body;

    const updatePayload = { name, status, sequence };
    if (schedule !== undefined) updatePayload.schedule = schedule;

    const { data: campaign, error: campError } = await supabase
      .from("campaigns")
      .update(updatePayload)
      .eq("id", id)
      .select();

    if (campError) throw campError;

    if (leads && leads.length > 0) {
      for (const lead of leads) {
        await supabase
          .from("leads")
          .update({
            firstName: lead.firstName,
            lastName: lead.lastName,
            email: lead.email,
            company: lead.company,
            status: lead.status,
            replied: lead.replied,
            repliedAt: lead.repliedAt,
            step: lead.step,
          })
          .eq("id", lead.id);
      }
    }

    res.json(campaign[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── ADD LEADS ───────────────────────────────────────────────────────────── */
app.post("/api/campaigns/:campaignId/leads", async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { leads } = req.body;

    const { data, error } = await supabase
      .from("leads")
      .insert(
        leads.map((l) => ({
          campaignId,
          firstName: l.firstName || "",
          lastName: l.lastName || "",
          email: l.email,
          company: l.company || "",
          iceBreaker: l.iceBreaker || "",
          status: "queued",
          replied: false,
          repliedAt: null,
          sentAt: null,
          step: 1,
          createdAt: new Date().toISOString(),
        }))
      )
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── DELETE LEAD ─────────────────────────────────────────────────────────── */
app.delete("/api/leads/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from("leads").delete().eq("id", id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── GET ACCOUNTS ────────────────────────────────────────────────────────── */
app.get("/api/accounts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("accounts")
      .select("*")
      .order("createdAt", { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── ADD ACCOUNT (NOW STORES REFRESH TOKEN) ──────────────────────────────── */
app.post("/api/accounts", async (req, res) => {
  try {
    const { email, label, limit, appPassword } = req.body;
    
    // appPassword now contains the refresh token from Google OAuth
    const { data, error } = await supabase
      .from("accounts")
      .insert([{
        email,
        label,
        limit,
        appPassword, // This is actually the refresh token
        active: true,
        sentToday: 0,
        createdAt: new Date().toISOString(),
      }])
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── DELETE ACCOUNT ──────────────────────────────────────────────────────── */
app.delete("/api/accounts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from("accounts").delete().eq("id", id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── API: SEND NOW ───────────────────────────────────────────────────────── */
app.post("/api/campaigns/:id/send-now", async (req, res) => {
  const debugLog = [];
  try {
    const { id } = req.params;
    debugLog.push(`Campaign ID: ${id}`);

    const { data: campaignData, error } = await supabase
      .from("campaigns")
      .select("*")
      .eq("id", id)
      .single();

    if (error) throw error;
    if (!campaignData) return res.status(404).json({ error: "Campaign not found" });
    if (!campaignData.sequence || campaignData.sequence.length === 0) {
      return res.status(400).json({ error: "Campaign has no email sequence. Add steps first." });
    }
    debugLog.push(`Campaign found: ${campaignData.name}`);

    const { data: leads, error: leadsError } = await supabase
      .from("leads")
      .select("*")
      .eq("campaignId", id)
      .in("status", ["queued", "sent"]);

    if (leadsError) throw leadsError;
    debugLog.push(`Leads found: ${leads?.length || 0}`);

    const { data: accounts, error: accError } = await supabase
      .from("accounts")
      .select("*")
      .eq("active", true);

    if (accError) throw accError;
    debugLog.push(`Active accounts: ${accounts?.length || 0}`);

    if (!accounts || accounts.length === 0) {
      return res.status(400).json({ error: "No active email accounts found", debug: debugLog });
    }

    const account = accounts.filter(a => a.sentToday < a.limit).sort((a, b) => a.sentToday - b.sentToday)[0];
    if (!account) {
      return res.status(400).json({ error: "All accounts at daily limit", debug: debugLog });
    }
    debugLog.push(`Using account: ${account.email}`);

    let sentCount = 0;
    let emailErrors = [];

    for (const lead of leads || []) {
      if (lead.replied) continue;
      if (lead.status !== "queued") continue;

      const stepConfig = campaignData.sequence[0];
      if (!stepConfig || !stepConfig.subject || !stepConfig.body) {
        debugLog.push(`Skipping ${lead.email} — step 1 incomplete`);
        continue;
      }

      const subject = interpolate(stepConfig.subject, lead);
      const body = interpolate(stepConfig.body, lead);
      debugLog.push(`Sending to ${lead.email}`);

      const sent = await sendEmailViaGmail(account, lead.email, subject, body);

      if (sent) {
        await supabase.from("leads").update({
          status: "sent",
          sentAt: new Date().toISOString(),
          step: 2,
        }).eq("id", lead.id);

        await supabase.from("accounts").update({ sentToday: account.sentToday + sentCount + 1 }).eq("id", account.id);

        sentCount++;
        debugLog.push(`✓ Sent to ${lead.email}`);
      } else {
        emailErrors.push({ email: lead.email });
      }
    }

    res.json({ success: true, sent: sentCount, debug: debugLog, errors: emailErrors });
  } catch (err) {
    res.status(500).json({ error: err.message, debug: debugLog });
  }
});

/* ─── CRON: DAILY EMAIL SCHEDULER ────────────────────────────────────────── */
cron.schedule("* * * * *", async () => {
  try {
    const { data: campaigns } = await supabase
      .from("campaigns")
      .select("*")
      .eq("status", "active");

    if (!campaigns || campaigns.length === 0) return;

    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + istOffset);
    const currentHour = istNow.getUTCHours();
    const currentMinute = istNow.getUTCMinutes();
    const currentTimeStr = `${String(currentHour).padStart(2,"0")}:${String(currentMinute).padStart(2,"0")}`;

    for (const campaign of campaigns) {
      const sendTime = campaign.schedule?.sendTime || "09:00";
      if (currentTimeStr !== sendTime) continue;

      console.log(`🚀 Scheduled send for: ${campaign.name}`);
      // Simplified cron send logic
    }
  } catch (err) {
    console.error("❌ Scheduler error:", err);
  }
}, { timezone: "UTC" });

/* ─── CRON: RESET COUNTERS ────────────────────────────────────────────────── */
cron.schedule("1 0 * * *", async () => {
  try {
    await supabase.from("accounts").update({ sentToday: 0 }).neq("id", "00000000-0000-0000-0000-000000000000");
    console.log("✓ Daily counters reset");
  } catch (err) {
    console.error("❌ Reset error:", err);
  }
}, { timezone: "Asia/Kolkata" });

/* ─── START ───────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`🚀 ColdReach Backend running on port ${PORT}`);
  console.log(`📧 Gmail API enabled - Scheduler active`);
});
