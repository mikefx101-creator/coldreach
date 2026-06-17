import express from "express";
import cors from "cors";
import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
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

/* ─── RESEND EMAIL API ────────────────────────────────────────────────────── */
const resend = new Resend(process.env.RESEND_API_KEY);
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "frdhdu55@gmail.com";

console.log(`✓ Resend initialized - sending from: ${RESEND_FROM_EMAIL}`);

/* ─── SEND EMAIL VIA RESEND ───────────────────────────────────────────────── */
const sendEmailViaResend = async (recipient, subject, body) => {
  try {
    const response = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: recipient,
      subject: subject,
      html: body.replace(/\n/g, "<br>") // Convert newlines to HTML breaks
    });

    if (response.error) {
      console.log(`Failed to send to ${recipient}: ${response.error.message}`);
      return false;
    }

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
      <p>We use Resend API to send emails on your behalf. We do not store email contents or access inboxes.</p>
      <h2>Data Security</h2>
      <p>All data is stored securely in Supabase PostgreSQL with encryption at rest.</p>
      <h2>Third-Party Services</h2>
      <p>We use Resend for email delivery and Supabase for data storage. See their privacy policies for more info.</p>
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

/* ─── ADD ACCOUNT ─────────────────────────────────────────────────────────── */
app.post("/api/accounts", async (req, res) => {
  try {
    const { email, label, limit } = req.body;
    
    const { data, error } = await supabase
      .from("accounts")
      .insert([{
        email: RESEND_FROM_EMAIL,
        label: label || email,
        limit: limit || 100,
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
      return res.status(400).json({ error: "No active sending accounts configured", debug: debugLog });
    }

    const account = accounts.filter(a => a.sentToday < a.limit).sort((a, b) => a.sentToday - b.sentToday)[0];
    if (!account) {
      return res.status(400).json({ error: "All accounts at daily limit", debug: debugLog });
    }
    debugLog.push(`Using account: ${account.label}`);

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

      const sent = await sendEmailViaResend(lead.email, subject, body);

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
      // Simplified cron send logic - triggers /send-now equivalent
      const { data: leads } = await supabase
        .from("leads")
        .select("*")
        .eq("campaignId", campaign.id)
        .eq("status", "queued");

      if (!leads || leads.length === 0) continue;

      const { data: accounts } = await supabase
        .from("accounts")
        .select("*")
        .eq("active", true);

      if (!accounts || accounts.length === 0) continue;

      const account = accounts.filter(a => a.sentToday < a.limit).sort((a, b) => a.sentToday - b.sentToday)[0];
      if (!account) continue;

      for (const lead of leads) {
        const stepConfig = campaign.sequence[0];
        if (!stepConfig || !stepConfig.subject || !stepConfig.body) continue;

        const subject = interpolate(stepConfig.subject, lead);
        const body = interpolate(stepConfig.body, lead);

        const sent = await sendEmailViaResend(lead.email, subject, body);
        if (sent) {
          await supabase.from("leads").update({
            status: "sent",
            sentAt: new Date().toISOString(),
            step: 2,
          }).eq("id", lead.id);

          await supabase.from("accounts").update({ sentToday: account.sentToday + 1 }).eq("id", account.id);
        }
      }
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
  console.log(`📧 Resend API enabled - Scheduler active`);
  console.log(`📬 Sending from: ${RESEND_FROM_EMAIL}`);
});
