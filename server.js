import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";
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

/* ─── GMAIL TRANSPORTER ───────────────────────────────────────────────────── */
const createTransporter = (email, appPassword) => {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: email, pass: appPassword },
  });
};

/* ─── HEALTH CHECK ────────────────────────────────────────────────────────── */
app.get("/", (req, res) => {
  res.json({ status: "ColdReach Backend Running", time: new Date().toISOString() });
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
    // Only update schedule if it was explicitly passed
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
    const { email, label, limit, appPassword } = req.body;

    const { data, error } = await supabase
      .from("accounts")
      .insert([{
        email,
        label,
        limit,
        appPassword,
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

/* ─── SEND EMAIL HELPER ───────────────────────────────────────────────────── */
const sendEmail = async (account, lead, subject, body) => {
  try {
    const transporter = createTransporter(account.email, account.appPassword);
    await transporter.sendMail({
      from: account.email,
      to: lead.email,
      subject,
      text: body,
    });
    return true;
  } catch (err) {
    console.log(`Failed to send to ${lead.email}: ${err.message}`);
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

/* ─── CORE SEND LOGIC (shared by cron + send-now) ────────────────────────── */
// isImmediate = true skips the start date / time check (Send Now button)
const processCampaignLeads = async (campaign, isImmediate = false) => {
  const today = new Date();
  // Convert to IST for date comparison
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(today.getTime() + istOffset);
  const istDateStr = istNow.toISOString().slice(0, 10); // "YYYY-MM-DD"

  // Check start date unless it's an immediate send
  if (!isImmediate && campaign.schedule?.startDate) {
    if (istDateStr < campaign.schedule.startDate) {
      console.log(`Campaign "${campaign.name}" start date not reached yet (${campaign.schedule.startDate})`);
      return 0;
    }
  }

  const { data: leads } = await supabase
    .from("leads")
    .select("*")
    .eq("campaignId", campaign.id)
    .in("status", ["queued", "sent"]);

  let sentCount = 0;

  for (const lead of leads || []) {
    if (lead.replied) continue;

    // Fetch fresh account list each lead so sentToday is always current
    const { data: accounts } = await supabase
      .from("accounts")
      .select("*")
      .eq("active", true);

    if (!accounts || accounts.length === 0) {
      console.log("No active accounts available");
      break;
    }

    const account = accounts
      .filter(a => a.sentToday < a.limit)
      .sort((a, b) => a.sentToday - b.sentToday)[0];

    if (!account) {
      console.log("All accounts at daily limit");
      break;
    }

    const currentStep = lead.step || 1;
    const stepConfig = campaign.sequence?.[currentStep - 1];

    if (!stepConfig) {
      console.log(`No step config for lead ${lead.id} step ${currentStep}`);
      continue;
    }

    let shouldSend = false;

    if (isImmediate) {
      // Send Now: send to all queued leads regardless of step day
      if (lead.status === "queued") shouldSend = true;
    } else {
      const istToday = new Date(istNow);
      istToday.setHours(0, 0, 0, 0);

      if (stepConfig.day === 0 && lead.status === "queued") {
        shouldSend = true;
      } else if (lead.sentAt && stepConfig.day > 0) {
        const sentDate = new Date(lead.sentAt);
        sentDate.setHours(0, 0, 0, 0);
        const daysAgo = Math.floor((istToday - sentDate) / (1000 * 60 * 60 * 24));
        if (daysAgo >= stepConfig.day) shouldSend = true;
      }
    }

    if (!shouldSend) continue;

    const subject = interpolate(stepConfig.subject, lead);
    const body = interpolate(stepConfig.body, lead);
    const sent = await sendEmail(account, lead, subject, body);

    if (sent) {
      await supabase
        .from("leads")
        .update({
          status: "sent",
          sentAt: new Date().toISOString(),
          step: Math.min(currentStep + 1, campaign.sequence?.length || 1),
        })
        .eq("id", lead.id);

      await supabase
        .from("accounts")
        .update({ sentToday: account.sentToday + 1 })
        .eq("id", account.id);

      sentCount++;
      console.log(`✓ Sent to ${lead.email} (Step ${currentStep})`);
    }
  }

  return sentCount;
};

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
    debugLog.push(`Campaign found: ${campaignData.name}, sequence steps: ${campaignData.sequence.length}`);

    // Fetch leads
    const { data: leads, error: leadsError } = await supabase
      .from("leads")
      .select("*")
      .eq("campaignId", id)
      .in("status", ["queued", "sent"]);

    if (leadsError) throw leadsError;
    debugLog.push(`Leads found: ${leads?.length || 0}`);

    // Fetch accounts
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
    debugLog.push(`Using account: ${account.email}, sentToday: ${account.sentToday}, limit: ${account.limit}`);

    let sentCount = 0;
    let emailErrors = [];

    for (const lead of leads || []) {
      if (lead.replied) { debugLog.push(`Skipping ${lead.email} — already replied`); continue; }
      if (lead.status !== "queued") { debugLog.push(`Skipping ${lead.email} — status is ${lead.status}`); continue; }

      const stepConfig = campaignData.sequence[0]; // Always send step 1 on Send Now
      debugLog.push(`Step config subject: "${stepConfig?.subject}", body length: ${stepConfig?.body?.length || 0}`);

      if (!stepConfig || !stepConfig.subject || !stepConfig.body) {
        debugLog.push(`Skipping ${lead.email} — step 1 has empty subject or body`);
        continue;
      }

      const subject = interpolate(stepConfig.subject, lead);
      const body = interpolate(stepConfig.body, lead);
      debugLog.push(`Sending to ${lead.email} with subject: "${subject}"`);

      try {
        const transporter = createTransporter(account.email, account.appPassword);
        await transporter.sendMail({ from: account.email, to: lead.email, subject, text: body });

        await supabase.from("leads").update({
          status: "sent",
          sentAt: new Date().toISOString(),
          step: Math.min(2, campaignData.sequence.length),
        }).eq("id", lead.id);

        await supabase.from("accounts").update({ sentToday: account.sentToday + sentCount + 1 }).eq("id", account.id);

        sentCount++;
        debugLog.push(`✓ Sent to ${lead.email}`);
      } catch (emailErr) {
        const errMsg = emailErr.message;
        debugLog.push(`✗ Failed to send to ${lead.email}: ${errMsg}`);
        emailErrors.push({ email: lead.email, error: errMsg });
      }
    }

    res.json({ success: true, sent: sentCount, debug: debugLog, errors: emailErrors });
  } catch (err) {
    res.status(500).json({ error: err.message, debug: debugLog });
  }
});

/* ─── CRON: DAILY EMAIL SCHEDULER ────────────────────────────────────────── */
// Runs every minute, checks each active campaign's scheduled send time
cron.schedule("* * * * *", async () => {
  try {
    const { data: campaigns } = await supabase
      .from("campaigns")
      .select("*")
      .eq("status", "active");

    if (!campaigns || campaigns.length === 0) return;

    // Get current IST time
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + istOffset);
    const currentHour = istNow.getUTCHours();
    const currentMinute = istNow.getUTCMinutes();
    const currentTimeStr = `${String(currentHour).padStart(2,"0")}:${String(currentMinute).padStart(2,"0")}`;

    for (const campaign of campaigns) {
      // Default send time is 09:00 IST if no schedule set
      const sendTime = campaign.schedule?.sendTime || "09:00";

      if (currentTimeStr !== sendTime) continue;

      console.log(`🚀 Scheduled send for campaign: "${campaign.name}" at ${sendTime} IST`);
      const sentCount = await processCampaignLeads(campaign, false);
      console.log(`✓ Campaign "${campaign.name}" sent ${sentCount} emails`);
    }
  } catch (err) {
    console.error("❌ Scheduler error:", err);
  }
}, { timezone: "UTC" }); // We handle IST offset manually above

/* ─── CRON: RESET DAILY COUNTERS (12:01 AM IST) ──────────────────────────── */
cron.schedule("1 0 * * *", async () => {
  try {
    await supabase
      .from("accounts")
      .update({ sentToday: 0 })
      .neq("id", "00000000-0000-0000-0000-000000000000");
    console.log("✓ Daily counters reset");
  } catch (err) {
    console.error("❌ Counter reset error:", err);
  }
}, { timezone: "Asia/Kolkata" });

/* ─── START ───────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`🚀 ColdReach Backend running on port ${PORT}`);
  console.log(`📧 Scheduler active — checks every minute for due campaigns`);
});
