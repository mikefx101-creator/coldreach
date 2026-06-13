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
    const { name, status, sequence, leads } = req.body;

    const { data: campaign, error: campError } = await supabase
      .from("campaigns")
      .update({ name, status, sequence })
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
    const { error } = await supabase
      .from("leads")
      .delete()
      .eq("id", id);

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
    const { error } = await supabase
      .from("accounts")
      .delete()
      .eq("id", id);

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
// Replaces all {{variables}} in both subject and body
const interpolate = (template, lead) => {
  if (!template) return "";
  return template
    .replace(/\{\{firstName\}\}/g, lead.firstName || "")
    .replace(/\{\{lastName\}\}/g, lead.lastName || "")
    .replace(/\{\{company\}\}/g, lead.company || "")
    .replace(/\{\{email\}\}/g, lead.email || "")
    .replace(/\{\{iceBreaker\}\}/g, lead.iceBreaker || "");
};

/* ─── CRON: DAILY EMAIL SCHEDULER (9 AM IST = 3:30 AM UTC) ──────────────── */
cron.schedule("30 3 * * *", async () => {
  console.log("🚀 Running daily email scheduler...");

  try {
    const { data: campaigns } = await supabase
      .from("campaigns")
      .select("*")
      .eq("status", "active");

    for (const campaign of campaigns || []) {
      const { data: leads } = await supabase
        .from("leads")
        .select("*")
        .eq("campaignId", campaign.id)
        .in("status", ["queued", "sent"]);

      for (const lead of leads || []) {
        if (lead.replied) continue;

        const { data: accounts } = await supabase
          .from("accounts")
          .select("*")
          .eq("active", true);

        if (!accounts || accounts.length === 0) {
          console.log("No active accounts available");
          continue;
        }

        // Load balance: pick account with lowest sentToday that hasn't hit limit
        const account = accounts
          .filter(a => a.sentToday < a.limit)
          .sort((a, b) => a.sentToday - b.sentToday)[0];

        if (!account) {
          console.log("All accounts at daily limit");
          continue;
        }

        const currentStep = lead.step || 1;
        const stepConfig = campaign.sequence?.[currentStep - 1];

        if (!stepConfig) {
          console.log(`No step config for lead ${lead.id} step ${currentStep}`);
          continue;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let shouldSend = false;

        if (stepConfig.day === 0 && lead.status === "queued") {
          shouldSend = true;
        } else if (lead.sentAt && stepConfig.day > 0) {
          const sentDate = new Date(lead.sentAt);
          sentDate.setHours(0, 0, 0, 0);
          const daysAgo = Math.floor((today - sentDate) / (1000 * 60 * 60 * 24));
          if (daysAgo >= stepConfig.day) shouldSend = true;
        }

        if (!shouldSend) continue;

        // Interpolate both subject and body
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

          console.log(`✓ Sent to ${lead.email} (Step ${currentStep})`);
        }
      }
    }

    console.log("✓ Daily scheduler completed");
  } catch (err) {
    console.error("❌ Scheduler error:", err);
  }
}, { timezone: "Asia/Kolkata" });

/* ─── CRON: RESET DAILY COUNTERS (12:01 AM IST) ──────────────────────────── */
cron.schedule("1 0 * * *", async () => {
  try {
    await supabase.from("accounts").update({ sentToday: 0 }).neq("id", "00000000-0000-0000-0000-000000000000");
    console.log("✓ Daily counters reset");
  } catch (err) {
    console.error("❌ Counter reset error:", err);
  }
}, { timezone: "Asia/Kolkata" });

/* ─── START ───────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`🚀 ColdReach Backend running on port ${PORT}`);
  console.log(`📧 Email scheduler active (9 AM IST daily)`);
});
