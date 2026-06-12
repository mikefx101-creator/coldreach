import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

/* ─── CORS - ALLOW FRONTEND REQUESTS ──────────────────────────────────────── */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

/* ─── SUPABASE ────────────────────────────────────────────────────────────── */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

/* ─── GMAIL CONFIG ────────────────────────────────────────────────────────── */
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

/* ─── API: GET ALL CAMPAIGNS ──────────────────────────────────────────────── */
app.get("/api/campaigns", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("campaigns")
      .select("*")
      .order("createdAt", { ascending: false });

    if (error) throw error;

    // Fetch leads for each campaign
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

/* ─── API: CREATE CAMPAIGN ────────────────────────────────────────────────── */
app.post("/api/campaigns", async (req, res) => {
  try {
    const { name, sequence } = req.body;
    const { data, error } = await supabase
      .from("campaigns")
      .insert([
        {
          name,
          status: "draft",
          sequence: sequence || [],
          createdAt: new Date().toISOString(),
        },
      ])
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── API: UPDATE CAMPAIGN ────────────────────────────────────────────────── */
app.put("/api/campaigns/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, status, sequence, leads } = req.body;

    // Update campaign
    const { data: campaign, error: campError } = await supabase
      .from("campaigns")
      .update({ name, status, sequence })
      .eq("id", id)
      .select();

    if (campError) throw campError;

    // Update leads
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

/* ─── API: ADD LEADS ──────────────────────────────────────────────────────── */
app.post("/api/campaigns/:campaignId/leads", async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { leads } = req.body;

    const { data, error } = await supabase
      .from("leads")
      .insert(
        leads.map((l) => ({
          ...l,
          campaignId,
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

/* ─── API: GET ACCOUNTS ───────────────────────────────────────────────────── */
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

/* ─── API: ADD ACCOUNT ────────────────────────────────────────────────────── */
app.post("/api/accounts", async (req, res) => {
  try {
    const { email, label, limit, appPassword } = req.body;

    const { data, error } = await supabase
      .from("accounts")
      .insert([
        {
          email,
          label,
          limit,
          appPassword,
          active: true,
          sentToday: 0,
          createdAt: new Date().toISOString(),
        },
      ])
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── API: TEST EMAIL ─────────────────────────────────────────────────────── */
app.post("/api/test-email", async (req, res) => {
  try {
    const { email, appPassword, testRecipient } = req.body;

    const transporter = createTransporter(email, appPassword);

    await transporter.sendMail({
      from: email,
      to: testRecipient,
      subject: "ColdReach Test Email",
      text: "This is a test email from ColdReach. If you see this, the connection is working!",
    });

    res.json({ success: true, message: "Test email sent" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── SEND EMAIL FUNCTION ─────────────────────────────────────────────────── */
const sendEmail = async (account, lead, emailBody, subject) => {
  try {
    const transporter = createTransporter(account.email, account.appPassword);

    await transporter.sendMail({
      from: account.email,
      to: lead.email,
      subject: subject,
      text: emailBody,
    });

    return true;
  } catch (err) {
    console.log(`Failed to send email to ${lead.email}: ${err.message}`);
    return false;
  }
};

/* ─── INTERPOLATE EMAIL ───────────────────────────────────────────────────── */
const interpolateEmail = (template, lead) => {
  return template
    .replace(/\{\{firstName\}\}/g, lead.firstName)
    .replace(/\{\{lastName\}\}/g, lead.lastName)
    .replace(/\{\{company\}\}/g, lead.company);
};

/* ─── CRON: DAILY EMAIL SCHEDULER (runs at 9 AM every day) ─────────────────── */
cron.schedule("0 9 * * *", async () => {
  console.log("🚀 Running daily email scheduler...");

  try {
    // Fetch all campaigns that are active
    const { data: campaigns } = await supabase
      .from("campaigns")
      .select("*")
      .eq("status", "active");

    for (const campaign of campaigns || []) {
      // Fetch leads for this campaign that are queued or in progress
      const { data: leads } = await supabase
        .from("leads")
        .select("*")
        .eq("campaignId", campaign.id)
        .in("status", ["queued", "sent"]);

      for (const lead of leads || []) {
        // Skip if already replied
        if (lead.replied) continue;

        // Fetch active accounts
        const { data: accounts } = await supabase
          .from("accounts")
          .select("*")
          .eq("active", true);

        // Pick an account with lowest sentToday count (load balancing)
        const account = accounts?.reduce((min, acc) =>
          acc.sentToday < min.sentToday ? acc : min
        );

        if (!account) {
          console.log("No active accounts available");
          continue;
        }

        // Check which step to send
        const currentStep = lead.step || 1;
        const stepConfig = campaign.sequence?.[currentStep - 1];

        if (!stepConfig) {
          console.log(`No step config for lead ${lead.id} step ${currentStep}`);
          continue;
        }

        // Check if it's time to send this step
        const today_ = new Date();
        today_.setHours(0, 0, 0, 0);
        let shouldSend = false;

        if (stepConfig.day === 0 && lead.status === "queued") {
          // Initial send
          shouldSend = true;
        } else if (lead.sentAt && stepConfig.day > 0) {
          // Follow-up send
          const sentDate = new Date(lead.sentAt);
          sentDate.setHours(0, 0, 0, 0);
          const daysAgo = Math.floor((today_ - sentDate) / (1000 * 60 * 60 * 24));
          if (daysAgo >= stepConfig.day) {
            shouldSend = true;
          }
        }

        if (!shouldSend) continue;
        if (account.sentToday >= account.limit) continue;

        // Interpolate email
        const subject = interpolateEmail(stepConfig.subject, lead);
        const body = interpolateEmail(stepConfig.body, lead);

        // Send email
        const sent = await sendEmail(account, lead, body, subject);

        if (sent) {
          // Update lead
          await supabase
            .from("leads")
            .update({
              status: "sent",
              sentAt: new Date().toISOString(),
              step: Math.min(currentStep + 1, campaign.sequence?.length || 1),
            })
            .eq("id", lead.id);

          // Update account sentToday
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
});

/* ─── RESET DAILY COUNTERS (runs at 12:01 AM every day) ───────────────────── */
cron.schedule("1 0 * * *", async () => {
  try {
    const { data: accounts } = await supabase.from("accounts").select("*");

    for (const acc of accounts || []) {
      await supabase.from("accounts").update({ sentToday: 0 }).eq("id", acc.id);
    }

    console.log("✓ Daily counters reset");
  } catch (err) {
    console.error("❌ Counter reset error:", err);
  }
});

/* ─── START SERVER ────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`🚀 ColdReach Backend running on port ${PORT}`);
  console.log(`📧 Email scheduler active`);
});
