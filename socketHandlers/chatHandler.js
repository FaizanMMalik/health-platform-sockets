const axios = require("axios");
const path = require("path");
const fs = require("fs");
const FormData = require("form-data");
const express = require("express");
const { withCache, invalidateCaseCache, getCacheStatus } = require("../cache");

const ROLE_ENUM = {
  PATIENT: "patient",
  DOCTOR: "doctor",
  STAFF: "staff",
  VHM: "vhm",
};

const MESSAGE_TYPE = {
  TEXT: "TextMessage",
  IMAGE: "ImageMessage",
  PDF: "PDFDocument",
  AUDIO: "AudioMessage",
  VIDEO: "VideoMessage",
};

const ATTACHMENT_TYPES = [
  MESSAGE_TYPE.IMAGE,
  MESSAGE_TYPE.PDF,
  MESSAGE_TYPE.AUDIO,
  MESSAGE_TYPE.VIDEO,
];

let isSeenColumnReady = false;
let isActingIdColumnReady = false;

// Aligns with Android ChatReadStatus (SENDING is client-only, not stored)
const MESSAGE_STATUS = {
  SENT: "SENT",
  RECEIVED: "RECEIVED",
  UNREAD: "UNREAD", // legacy alias → RECEIVED
  READ: "READ",
};

function emptyIsSeenState() {
  return {
    SENT: [],
    RECEIVED: [],
    READ: [],
  };
}

function uniqueIds(ids) {
  return [...new Set((ids || []).map(Number).filter((n) => !Number.isNaN(n)))];
}

function normalizeMessageStatus(status) {
  const raw = String(status || MESSAGE_STATUS.READ)
    .trim()
    .toUpperCase();
  const aliases = {
    SENT: MESSAGE_STATUS.SENT,
    SEND: MESSAGE_STATUS.SENT,
    RECEIVED: MESSAGE_STATUS.RECEIVED,
    DELIVERED: MESSAGE_STATUS.RECEIVED,
    UNREAD: MESSAGE_STATUS.RECEIVED,
    READ: MESSAGE_STATUS.READ,
    SEEN: MESSAGE_STATUS.READ,
  };
  return aliases[raw] || null;
}

function parseIsSeen(value) {
  const empty = emptyIsSeenState();
  if (!value) return empty;

  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return empty;
    }
  }

  // Legacy: plain array of user ids → treat as READ list
  if (Array.isArray(parsed)) {
    return {
      SENT: [],
      RECEIVED: [],
      READ: uniqueIds(parsed),
    };
  }

  if (parsed && typeof parsed === "object") {
    // Support new keys + legacy send/delivered/seen
    return {
      SENT: uniqueIds(parsed.SENT || parsed.sent || parsed.send),
      RECEIVED: uniqueIds(
        parsed.RECEIVED ||
          parsed.received ||
          parsed.delivered ||
          parsed.UNREAD ||
          parsed.unread,
      ),
      READ: uniqueIds(parsed.READ || parsed.read || parsed.seen),
    };
  }

  return empty;
}

function removeUserFromBuckets(state, userId) {
  const uid = Number(userId);
  return {
    SENT: state.SENT.filter((id) => id !== uid),
    RECEIVED: state.RECEIVED.filter((id) => id !== uid),
    READ: state.READ.filter((id) => id !== uid),
  };
}

function applyMessageStatus(state, status, userId, memberIds = []) {
  const current = parseIsSeen(state);
  const uid = Number(userId);
  const normalized = normalizeMessageStatus(status);

  if (normalized === MESSAGE_STATUS.SENT) {
    if (Number.isNaN(uid)) return current;
    const next = removeUserFromBuckets(current, uid);
    next.SENT.push(uid);
    return {
      SENT: uniqueIds(next.SENT),
      RECEIVED: uniqueIds(next.RECEIVED),
      READ: uniqueIds(next.READ),
    };
  }

  if (normalized === MESSAGE_STATUS.RECEIVED) {
    // All case members go to RECEIVED (except already READ / already in SENT)
    const sentSet = new Set(current.SENT);
    const readSet = new Set(current.READ);
    const members = uniqueIds(memberIds.length ? memberIds : [uid]);
    const received = members.filter(
      (id) => !sentSet.has(id) && !readSet.has(id),
    );
    return {
      SENT: uniqueIds(current.SENT),
      RECEIVED: uniqueIds([
        ...current.RECEIVED.filter((id) => !readSet.has(id)),
        ...received,
      ]),
      READ: uniqueIds(current.READ),
    };
  }

  if (normalized === MESSAGE_STATUS.READ) {
    if (Number.isNaN(uid)) return current;
    const next = removeUserFromBuckets(current, uid);
    next.READ.push(uid);
    return {
      SENT: uniqueIds(next.SENT),
      RECEIVED: uniqueIds(next.RECEIVED),
      READ: uniqueIds(next.READ),
    };
  }

  return current;
}

async function ensureIsSeenColumn(db) {
  if (isSeenColumnReady) return;
  try {
    const hasColumn = await db.schema.hasColumn("chat", "is_seen");
    if (!hasColumn) {
      await db.schema.table("chat", (table) => {
        table.text("is_seen").nullable();
      });
    }
  } catch (error) {
    console.warn("[ensureIsSeenColumn]", error.message);
  }
  isSeenColumnReady = true;
}

async function ensureActingIdColumn(db) {
  if (isActingIdColumnReady) return;
  try {
    const hasColumn = await db.schema.hasColumn("chat", "actingId");
    if (!hasColumn) {
      await db.schema.table("chat", (table) => {
        table.integer("actingId").nullable();
      });
    }
  } catch (error) {
    console.warn("[ensureActingIdColumn]", error.message);
  }
  isActingIdColumnReady = true;
}

function resolveActingId(value) {
  if (value == null || value === "") return null;
  const id = Number(value);
  return Number.isNaN(id) ? null : id;
}

function buildNotificationTitle(senderRole, senderName) {
  if (senderRole === ROLE_ENUM.DOCTOR) {
    return `Dr. ${senderName}`;
  }
  return `${senderRole || ""} ${senderName}`.trim();
}

function buildNotificationBody(senderRole, senderName, message) {
  const title = buildNotificationTitle(senderRole, senderName);
  const preview =
    message && message.length > 50 ? message.substring(0, 50) + "..." : message;
  return `${title}: ${preview}`;
}

function getAttachmentMimeType(messageType) {
  switch (messageType) {
    case MESSAGE_TYPE.IMAGE:
      return "image";
    case MESSAGE_TYPE.VIDEO:
      return "video";
    case MESSAGE_TYPE.AUDIO:
      return "audio";
    case MESSAGE_TYPE.PDF:
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

async function uploadFileToServer(filePath, messageType, baseUrl) {
  const fileName = path.basename(filePath);
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath), {
    filename: fileName,
    contentType: getAttachmentMimeType(messageType),
  });

  const response = await axios.post(`${baseUrl}/api/upload-single`, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return response.data;
}

function validateChatRules({ senderRole, receiverRole, chat_mode }) {
  const errors = [];

  const isDoctorPatientChat =
    (senderRole === ROLE_ENUM.DOCTOR && receiverRole === ROLE_ENUM.PATIENT) ||
    (senderRole === ROLE_ENUM.PATIENT && receiverRole === ROLE_ENUM.DOCTOR);

  if (chat_mode === "general" && !isDoctorPatientChat) {
    errors.push(
      "General chat mode is only available for doctor ↔ patient messaging",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/* ===================== Case invite + users (shared REST + socket) ===================== */

function createCaseContext(db, sendPushNotificationMessage) {
  function mapProfile(profile) {
    if (!profile) return null;
    return {
      user_id: profile.user_id,
      first_name: profile.first_name || "",
      last_name: profile.last_name || "",
      email: profile.email || "",
      role: profile.role || "",
      image: profile.image || "",
      status: profile.status || "",
    };
  }

  async function getProfilesByUserIds(userIds) {
    const ids = [
      ...new Set(
        userIds.map((id) => Number(id)).filter((id) => !Number.isNaN(id)),
      ),
    ];
    if (ids.length === 0) return new Map();

    const rows = await db("profile")
      .whereIn("user_id", ids)
      .select(
        "user_id",
        "first_name",
        "last_name",
        "email",
        "role",
        "image",
        "status",
      );

    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.user_id)) map.set(row.user_id, row);
    }
    return map;
  }

  async function enrichInvite(invite) {
    if (!invite) return null;
    const profiles = await getProfilesByUserIds([
      invite.sender_id,
      invite.user_id,
    ]);
    return {
      ...invite,
      sender: mapProfile(profiles.get(Number(invite.sender_id))),
      user: mapProfile(profiles.get(Number(invite.user_id))),
    };
  }

  async function enrichInvites(invites) {
    if (!invites?.length) return [];
    const ids = invites.flatMap((i) => [i.sender_id, i.user_id]);
    const profiles = await getProfilesByUserIds(ids);
    return invites.map((invite) => ({
      ...invite,
      sender: mapProfile(profiles.get(Number(invite.sender_id))),
      user: mapProfile(profiles.get(Number(invite.user_id))),
    }));
  }

  function buildUsersFromInvites(invites) {
    const userMap = new Map();

    for (const invite of invites) {
      const entries = [
        { userId: invite.user_id, role: "member", invite },
        { userId: invite.sender_id, role: "sender", invite },
      ];

      for (const entry of entries) {
        const id = Number(entry.userId);
        if (Number.isNaN(id)) continue;

        const existing = userMap.get(id);
        const inviteStatus = invite.status;

        if (existing) {
          if (inviteStatus === "accepted" && existing.status !== "accepted") {
            userMap.set(id, {
              user_id: id,
              status: inviteStatus,
              membership: entry.role,
              invite_id: invite.id,
              invited_by: entry.role === "member" ? invite.sender_id : null,
            });
          }
          continue;
        }

        userMap.set(id, {
          user_id: id,
          status: inviteStatus,
          membership: entry.role,
          invite_id: invite.id,
          invited_by: entry.role === "member" ? invite.sender_id : null,
        });
      }
    }

    return userMap;
  }

  async function getCaseUsers(case_id, status) {
    const query = db("invite_case")
      .where("case_id", case_id)
      .orderBy("id", "desc");
    if (status) query.where("status", status);

    const invites = await query;
    const userMap = buildUsersFromInvites(invites);
    const profiles = await getProfilesByUserIds([...userMap.keys()]);

    const users = [...userMap.values()].map((item) => ({
      ...mapProfile(profiles.get(item.user_id)),
      status: item.status,
      membership: item.membership,
      invite_id: item.invite_id,
      invited_by: item.invited_by,
    }));

    return {
      case_id,
      users,
      accepted: users.filter((u) => u.status === "accepted"),
      pending: users.filter((u) => u.status === "pending"),
      invites: await enrichInvites(invites),
    };
  }

  async function getCaseMemberIds(case_id, excludeUserId) {
    const invites = await db("invite_case").where("case_id", case_id);
    const ids = new Set();
    for (const invite of invites) {
      const senderId = Number(invite.sender_id);
      const userId = Number(invite.user_id);
      if (!Number.isNaN(senderId)) ids.add(senderId);
      if (!Number.isNaN(userId)) ids.add(userId);
    }
    const excluded = Number(excludeUserId);
    if (!Number.isNaN(excluded)) ids.delete(excluded);
    return [...ids];
  }

  function isPlaceholderProfile(profile) {
    if (!profile) return false;
    const email = String(profile.email || "");
    if (email.includes("@placeholder.local")) return true;
    if (
      profile.first_name === "User" &&
      String(profile.last_name) === String(profile.user_id)
    )
      return true;
    return false;
  }

  function hasProfileData(defaults = {}) {
    const email = String(defaults.email || "").trim();
    if (email && !email.includes("@placeholder.local")) return true;

    const name = String(defaults.name || defaults.fullName || "").trim();
    if (name) return true;

    const firstName = String(
      defaults.first_name || defaults.firstName || "",
    ).trim();
    if (firstName && firstName !== "User") return true;

    const lastName = String(
      defaults.last_name || defaults.lastName || "",
    ).trim();
    if (lastName && !/^\d+$/.test(lastName)) return true;

    return false;
  }

  function buildProfileFields(userId, defaults = {}) {
    const id = Number(userId);
    const fullName = String(defaults.name || defaults.fullName || "").trim();
    const nameParts = fullName ? fullName.split(/\s+/) : [];
    return {
      user_id: id,
      first_name:
        defaults.first_name || defaults.firstName || nameParts[0] || "",
      last_name:
        defaults.last_name ||
        defaults.lastName ||
        nameParts.slice(1).join(" ") ||
        "",
      email: defaults.email || "",
      image: defaults.image || "",
      role: defaults.role || "",
      status: defaults.status || "isActive",
    };
  }

  async function getProfile(userId) {
    const id = Number(userId);
    if (Number.isNaN(id)) return null;
    return db("profile").where("user_id", id).first();
  }

  async function ensureProfile(userId, defaults = {}) {
    const id = Number(userId);
    if (Number.isNaN(id)) return null;

    const existing = await db("profile").where("user_id", id).first();
    if (existing) {
      if (isPlaceholderProfile(existing) && hasProfileData(defaults)) {
        const fields = buildProfileFields(id, defaults);
        const updates = {};
        if (fields.first_name) updates.first_name = fields.first_name;
        if (fields.last_name) updates.last_name = fields.last_name;
        if (fields.email) updates.email = fields.email;
        if (fields.image) updates.image = fields.image;
        if (fields.role) updates.role = fields.role;
        if (Object.keys(updates).length > 0) {
          await db("profile").where("user_id", id).update(updates);
          return db("profile").where("user_id", id).first();
        }
      }
      return existing;
    }

    if (!hasProfileData(defaults)) return null;

    const fields = buildProfileFields(id, defaults);
    await db("profile").insert({
      user_id: id,
      first_name: fields.first_name || "User",
      last_name: fields.last_name || String(id),
      email: fields.email || `user${id}@placeholder.local`,
      image: fields.image,
      role: fields.role || "user",
      status: fields.status,
    });

    return db("profile").where("user_id", id).first();
  }

  async function resolveProfile(userId, defaults = {}) {
    const profile = await ensureProfile(userId, defaults);
    if (profile) return profile;
    return buildProfileFields(userId, defaults);
  }

  async function isCaseMember(case_id, userId) {
    const id = Number(userId);
    if (Number.isNaN(id)) return false;

    const invite = await db("invite_case")
      .where("case_id", case_id)
      .where("status", "accepted")
      .where(function () {
        this.where("sender_id", id).orWhere("user_id", id);
      })
      .first();

    return Boolean(invite);
  }

  async function sendFcmToUser(userId, { action, title, body, data = {} }) {
    const userTokens = await db("fcmtoken")
      .where("user_id", userId)
      .select("token");
    const tokenList = userTokens.map((t) => t.token).filter(Boolean);
    if (tokenList.length === 0) return { sent: 0 };

    const messages = tokenList.map((token) => ({
      token,
      data: {
        ACTION: JSON.stringify(action),
        title: JSON.stringify(title),
        body: JSON.stringify(body),
        ...Object.fromEntries(
          Object.entries(data).map(([k, v]) => [
            k,
            v == null ? null : String(v),
          ]),
        ),
      },
      notification: { title, body },
    }));

    await sendPushNotificationMessage(messages);
    return { sent: tokenList.length };
  }

  async function inviteCase(payload) {
    const {
      case_id,
      caseId,
      sender_id,
      user_id,
      sender_name,
      senderName,
      invitee_name,
      inviteeName,
      user_name,
      sender_email,
      invitee_email,
      user_email,
      sender_role,
      invitee_role,
      user_role,
      sender_first_name,
      sender_last_name,
      invitee_first_name,
      invitee_last_name,
      user_first_name,
      user_last_name,
    } = payload || {};

    const resolvedCaseId = case_id || caseId;

    if (!resolvedCaseId)
      return {
        httpStatus: 400,
        body: { status: false, message: "case_id is required" },
      };
    if (sender_id == null || sender_id === "")
      return {
        httpStatus: 400,
        body: { status: false, message: "sender_id is required" },
      };
    if (user_id == null || user_id === "")
      return {
        httpStatus: 400,
        body: { status: false, message: "user_id is required" },
      };
    if (String(sender_id) === String(user_id)) {
      return {
        httpStatus: 400,
        body: { status: false, message: "Cannot invite yourself to a case" },
      };
    }

    const senderProfile = await ensureProfile(sender_id, {
      name: sender_name || senderName,
      first_name: sender_first_name,
      last_name: sender_last_name,
      email: sender_email,
      role: sender_role || "doctor",
    });

    await ensureProfile(user_id, {
      name: invitee_name || inviteeName || user_name,
      first_name: invitee_first_name || user_first_name,
      last_name: invitee_last_name || user_last_name,
      email: invitee_email || user_email,
      role: invitee_role || user_role || "user",
    });

    const existing = await db("invite_case")
      .where({ case_id: resolvedCaseId, user_id })
      .whereIn("status", ["pending", "accepted"])
      .first();

    if (existing) {
      const invite = await enrichInvite(existing);
      return {
        httpStatus: 409,
        body: {
          status: false,
          message:
            existing.status === "accepted"
              ? "User already accepted this case"
              : "Invite already pending for this user",
          invite,
        },
      };
    }

    const [inviteId] = await db("invite_case").insert({
      case_id: resolvedCaseId,
      sender_id,
      user_id,
      status: "pending",
      created_at: new Date().toISOString(),
    });

    const inviteRow = await db("invite_case").where({ id: inviteId }).first();
    const invite = await enrichInvite(inviteRow);

    const senderDisplayName = senderProfile
      ? `${senderProfile.first_name || ""} ${senderProfile.last_name || ""}`.trim()
      : String(sender_name || senderName || "").trim();
    const fcm = await sendFcmToUser(user_id, {
      action: "CASE_INVITE",
      title: "Case invite",
      body: `${senderDisplayName || "Someone"} invited you to a case`,
      data: {
        case_id: resolvedCaseId,
        sender_id,
        user_id,
        invite_id: inviteId,
        status: "pending",
      },
    });

    await invalidateCaseCache(resolvedCaseId);

    return {
      httpStatus: 200,
      body: {
        status: true,
        message: "Invite sent",
        ACTION: "CASE_INVITE",
        invite,
        fcm,
      },
      emit: { user_id, case_id: resolvedCaseId },
    };
  }

  async function acceptCaseInvite({ case_id, caseId, user_id, invite_id }) {
    const resolvedCaseId = case_id || caseId;

    if (user_id == null || user_id === "") {
      return {
        httpStatus: 400,
        body: { status: false, message: "user_id is required" },
      };
    }

    let invite = null;
    if (invite_id) {
      invite = await db("invite_case")
        .where({ id: invite_id, user_id })
        .first();
    } else if (resolvedCaseId) {
      invite = await db("invite_case")
        .where({ case_id: resolvedCaseId, user_id, status: "pending" })
        .orderBy("id", "desc")
        .first();
    } else {
      return {
        httpStatus: 400,
        body: { status: false, message: "invite_id or case_id is required" },
      };
    }

    if (!invite)
      return {
        httpStatus: 404,
        body: { status: false, message: "Pending invite not found" },
      };

    if (invite.status === "accepted") {
      const enriched = await enrichInvite(invite);
      return {
        httpStatus: 200,
        body: {
          status: true,
          message: "Already accepted",
          ACTION: "CASE_INVITE_ACCEPTED",
          invite: enriched,
        },
        emit: { case_id: invite.case_id, sender_id: invite.sender_id, user_id },
      };
    }

    if (invite.status !== "pending") {
      return {
        httpStatus: 400,
        body: {
          status: false,
          message: `Invite cannot be accepted from status: ${invite.status}`,
        },
      };
    }

    await db("invite_case").where({ id: invite.id }).update({
      status: "accepted",
      updated_at: new Date().toISOString(),
    });

    const inviteRow = await db("invite_case").where({ id: invite.id }).first();
    const updatedInvite = await enrichInvite(inviteRow);

    const accepterName = updatedInvite.user
      ? `${updatedInvite.user.first_name || ""} ${updatedInvite.user.last_name || ""}`.trim()
      : "";

    const fcm = await sendFcmToUser(invite.sender_id, {
      action: "CASE_INVITE_ACCEPTED",
      title: "Case invite accepted",
      body: `${accepterName || "User"} accepted the case invite`,
      data: {
        case_id: invite.case_id,
        sender_id: invite.sender_id,
        user_id: invite.user_id,
        invite_id: invite.id,
        status: "accepted",
      },
    });

    await invalidateCaseCache(invite.case_id);

    return {
      httpStatus: 200,
      body: {
        status: true,
        message: "Invite accepted",
        ACTION: "CASE_INVITE_ACCEPTED",
        invite: updatedInvite,
        fcm,
      },
      emit: { case_id: invite.case_id, sender_id: invite.sender_id, user_id },
    };
  }

  async function resolveCasePatientIdFromChat(case_id) {
    const chatRow = await db("chat")
      .where("case_id", case_id)
      .whereNotNull("patientId")
      .where("patientId", "!=", "")
      .orderBy("id", "desc")
      .first();

    if (chatRow?.patientId == null) return null;

    const patientId = Number(chatRow.patientId);
    return Number.isNaN(patientId) ? null : patientId;
  }

  async function ensurePatientInviteAccepted(case_id, patientId, senderId) {
    const pid = Number(patientId);
    if (Number.isNaN(pid)) return { added: false, invite: null };

    const existing = await db("invite_case")
      .where("case_id", case_id)
      .where(function () {
        this.where("user_id", pid).orWhere("sender_id", pid);
      })
      .orderBy("id", "desc")
      .first();

    if (existing) {
      if (Number(existing.user_id) === pid && existing.status !== "accepted") {
        await db("invite_case").where({ id: existing.id }).update({
          status: "accepted",
          updated_at: new Date().toISOString(),
        });
        await invalidateCaseCache(case_id);
        return {
          added: false,
          updated: true,
          invite: await db("invite_case").where({ id: existing.id }).first(),
        };
      }
      return { added: false, updated: false, invite: existing };
    }

    let resolvedSenderId = Number(senderId);
    if (Number.isNaN(resolvedSenderId)) {
      const anyInvite = await db("invite_case")
        .where("case_id", case_id)
        .orderBy("id", "asc")
        .first();
      resolvedSenderId = anyInvite ? Number(anyInvite.sender_id) : pid;
    }

    await ensureProfile(pid, { role: "patient" });

    const now = new Date().toISOString();
    const [inviteId] = await db("invite_case").insert({
      case_id,
      sender_id: resolvedSenderId,
      user_id: pid,
      status: "accepted",
      created_at: now,
      updated_at: now,
    });

    await invalidateCaseCache(case_id);

    return {
      added: true,
      updated: false,
      invite: await db("invite_case").where({ id: inviteId }).first(),
    };
  }

  async function listCaseInvites({ case_id, caseId, status, refresh }) {
    const resolvedCaseId = case_id || caseId;
    if (resolvedCaseId == null || resolvedCaseId === "") {
      return {
        httpStatus: 400,
        body: { status: false, message: "case_id is required" },
      };
    }

    const resolvedPatientId =
      await resolveCasePatientIdFromChat(resolvedCaseId);
    let patientEnsured = false;
    if (resolvedPatientId != null) {
      const ensureResult = await ensurePatientInviteAccepted(
        resolvedCaseId,
        resolvedPatientId,
      );
      patientEnsured = Boolean(ensureResult.added || ensureResult.updated);
    }

    const cachePayload = { case_id: resolvedCaseId, status: status || null };
    const body = await withCache({
      endpoint: "list-case-invites",
      payload: cachePayload,
      caseId: resolvedCaseId,
      skipCache: Boolean(refresh) || patientEnsured,
      fetchFn: async () => {
        const query = db("invite_case")
          .select("invite_case.*")
          .where("invite_case.case_id", resolvedCaseId)
          .orderBy("invite_case.id", "desc");
        if (status) query.where("invite_case.status", status);
        const rows = await query;
        const invites = await enrichInvites(rows);
        return {
          status: true,
          ACTION: "CASE_INVITE_LIST",
          invites,
          case_id: resolvedCaseId,
          filter_status: status || null,
        };
      },
    });

    return { httpStatus: 200, body, emit: { case_id: resolvedCaseId } };
  }

  async function fetchCaseUsers({ case_id, caseId, status, refresh }) {
    const resolvedCaseId = case_id || caseId;
    if (resolvedCaseId == null || resolvedCaseId === "") {
      return {
        httpStatus: 400,
        body: { status: false, message: "case_id is required" },
      };
    }

    const resolvedPatientId =
      await resolveCasePatientIdFromChat(resolvedCaseId);
    let patientEnsured = false;
    if (resolvedPatientId != null) {
      const ensureResult = await ensurePatientInviteAccepted(
        resolvedCaseId,
        resolvedPatientId,
      );
      patientEnsured = Boolean(ensureResult.added || ensureResult.updated);
    }

    const cachePayload = { case_id: resolvedCaseId, status: status || null };
    const body = await withCache({
      endpoint: "get-case-users",
      payload: cachePayload,
      caseId: resolvedCaseId,
      skipCache: Boolean(refresh) || patientEnsured,
      fetchFn: async () => {
        const data = await getCaseUsers(resolvedCaseId, status);
        return {
          status: true,
          ACTION: "CASE_USERS",
          case_id: data.case_id,
          users: data.users,
          filter_status: status || null,
        };
      },
    });

    return { httpStatus: 200, body, emit: { case_id: resolvedCaseId } };
  }

  async function markCaseMessageSeen({
    message_id,
    msgId,
    user_id,
    userId,
    status,
  }) {
    const id = message_id || msgId;
    const uid = Number(user_id || userId);
    const resolvedStatus = normalizeMessageStatus(
      status || MESSAGE_STATUS.READ,
    );

    if (id == null || id === "") {
      return {
        httpStatus: 400,
        body: { status: false, message: "message_id is required" },
      };
    }

    if (!resolvedStatus) {
      return {
        httpStatus: 400,
        body: {
          status: false,
          message:
            "status must be one of: SENT, RECEIVED, UNREAD, READ (SENDING is client-only)",
        },
      };
    }

    if (resolvedStatus !== MESSAGE_STATUS.RECEIVED && Number.isNaN(uid)) {
      return {
        httpStatus: 400,
        body: { status: false, message: "user_id is required" },
      };
    }

    await ensureIsSeenColumn(db);

    const message = await db("chat").where({ id }).first();
    if (!message) {
      return {
        httpStatus: 404,
        body: { status: false, message: "Message not found" },
      };
    }

    let memberIds = [];
    if (resolvedStatus === MESSAGE_STATUS.RECEIVED && message.case_id) {
      memberIds = await getCaseMemberIds(message.case_id);
      if (message.from_id != null) memberIds.push(Number(message.from_id));
    }

    const nextIsSeen = applyMessageStatus(
      message.is_seen,
      resolvedStatus,
      uid,
      memberIds,
    );

    await db("chat")
      .where({ id })
      .update({ is_seen: JSON.stringify(nextIsSeen) });
    if (message.case_id) {
      await invalidateCaseCache(message.case_id);
    }

    return {
      httpStatus: 200,
      body: {
        status: true,
        ACTION: "CASE_MESSAGE_SEEN",
        message_id: Number(id),
        case_id: message.case_id || null,
        user_id: Number.isNaN(uid) ? null : uid,
        message_status: resolvedStatus,
        is_seen: nextIsSeen,
      },
      emit: {
        case_id: message.case_id || null,
        message_id: Number(id),
        user_id: Number.isNaN(uid) ? null : uid,
        message_status: resolvedStatus,
      },
    };
  }

  function createApiRouter() {
    const router = express.Router();

    router.post("/invite-case", async (req, res) => {
      try {
        const result = await inviteCase(req.body);
        return res.status(result.httpStatus).json(result.body);
      } catch (error) {
        console.error("[API invite-case]", error);
        return res
          .status(500)
          .json({
            status: false,
            message: "Error sending case invite",
            error: error.message,
          });
      }
    });

    router.post("/accept-case-invite", async (req, res) => {
      try {
        const result = await acceptCaseInvite(req.body);
        return res.status(result.httpStatus).json(result.body);
      } catch (error) {
        console.error("[API accept-case-invite]", error);
        return res
          .status(500)
          .json({
            status: false,
            message: "Error accepting case invite",
            error: error.message,
          });
      }
    });

    router.post("/list-case-invites", async (req, res) => {
      try {
        const result = await listCaseInvites(req.body || {});
        return res.status(result.httpStatus).json(result.body);
      } catch (error) {
        console.error("[API list-case-invites]", error);
        return res
          .status(500)
          .json({
            status: false,
            message: "Error listing case invites",
            error: error.message,
          });
      }
    });

    router.post("/get-case-users", async (req, res) => {
      try {
        const result = await fetchCaseUsers(req.body || {});
        return res.status(result.httpStatus).json(result.body);
      } catch (error) {
        console.error("[API get-case-users]", error);
        return res
          .status(500)
          .json({
            status: false,
            message: "Error fetching case users",
            error: error.message,
          });
      }
    });

    router.get("/cache/status", async (req, res) => {
      try {
        const status = await getCacheStatus();
        return res.status(200).json({ status: true, cache: status });
      } catch (error) {
        return res.status(500).json({ status: false, message: error.message });
      }
    });

    router.post("/cache/invalidate", async (req, res) => {
      try {
        const { case_id } = req.body || {};
        if (!case_id)
          return res
            .status(400)
            .json({ status: false, message: "case_id is required" });
        const result = await invalidateCaseCache(case_id);
        return res.status(200).json({ status: true, case_id, ...result });
      } catch (error) {
        return res.status(500).json({ status: false, message: error.message });
      }
    });

    return router;
  }

  return {
    mapProfile,
    getProfilesByUserIds,
    enrichInvite,
    enrichInvites,
    getCaseUsers,
    getCaseMemberIds,
    isCaseMember,
    getProfile,
    ensureProfile,
    resolveProfile,
    inviteCase,
    acceptCaseInvite,
    listCaseInvites,
    fetchCaseUsers,
    markCaseMessageSeen,
    createApiRouter,
  };
}

function createCaseApiRouter(db, sendPushNotificationMessage) {
  return createCaseContext(db, sendPushNotificationMessage).createApiRouter();
}

function registerChatHandlers(
  io,
  socket,
  db,
  sendPushNotificationMessage,
  baseUrl,
) {
  const caseCtx = createCaseContext(db, sendPushNotificationMessage);

  socket.on("send-message", async (data, ackCallback) => {
    try {
      let {
        from,
        to,
        message,
        messageType,
        attachment,
        iscaregiver,
        metadata,
        metaData,
        patientId,
        doctorId,
        case_id,
        caseId,
        patientUserName,
        patientUserProfile,
        doctorUserName,
        doctorUserProfile,
        chat_mode,
        senderRole: senderRoleFromFrontend,
        receiverRole: receiverRoleFromFrontend,
        fromUserRole,
        toUserRole,
        fromUserName,
        fromUserProfile,
        toUserName,
        toUserProfile,
      } = data;

      if (!senderRoleFromFrontend && fromUserRole)
        senderRoleFromFrontend = fromUserRole;
      if (!receiverRoleFromFrontend && toUserRole)
        receiverRoleFromFrontend = toUserRole;

      if (!messageType) messageType = MESSAGE_TYPE.TEXT;
      if (!chat_mode) chat_mode = messageType;

      const resolvedCaseId = case_id || caseId || null;

      if (!from && from !== 0) {
        const errorMsg = "From user ID is required";
        socket.emit("notification-error", { status: false, message: errorMsg });
        if (ackCallback) ackCallback({ status: false, error: errorMsg });
        return;
      }
      if (!to && to !== 0) {
        const errorMsg = "To user ID is required";
        socket.emit("notification-error", { status: false, message: errorMsg });
        if (ackCallback) ackCallback({ status: false, error: errorMsg });
        return;
      }

      from = parseInt(from) || from;
      to = parseInt(to) || to;

      const utcDateString = new Date().toISOString();
      const queries = [
        db("profile").where("user_id", from).first(),
        db("profile").where("user_id", to).first(),
      ];

      if (patientId)
        queries.push(
          db("profile").where("user_id", parseInt(patientId)).first(),
        );
      if (doctorId)
        queries.push(
          db("profile").where("user_id", parseInt(doctorId)).first(),
        );

      const results = await Promise.all(queries);
      const fromU = results[0];
      const toU = results[1];
      let resultIndex = 2;
      const patientData = patientId ? results[resultIndex++] : null;
      const doctorData = doctorId ? results[resultIndex++] : null;

      if (!fromU || !toU) {
        const errorMsg = !fromU ? "From User not found" : "To User not found";
        socket.emit("notification-error", { status: false, message: errorMsg });
        if (ackCallback) ackCallback({ status: false, error: errorMsg });
        return;
      }

      const senderRole = senderRoleFromFrontend || fromU.role || "";
      const receiverRole = receiverRoleFromFrontend || toU.role || "";
      const chatType = `${senderRole}-${receiverRole}`;

      const validation = validateChatRules({
        senderRole,
        receiverRole,
        chat_mode,
      });
      if (!validation.valid) {
        const errorMsg = validation.errors.join("; ");
        socket.emit("notification-error", { status: false, message: errorMsg });
        if (ackCallback) ackCallback({ status: false, error: errorMsg });
        return;
      }

      let chatAttachment = null;
      const chatMessage = message || "";
      const chatMetaData = metaData || metadata || {};

      if (ATTACHMENT_TYPES.includes(messageType)) {
        if (Array.isArray(attachment)) {
          chatAttachment = attachment;
        } else if (typeof attachment === "string") {
          chatAttachment = [attachment];
        } else {
          chatAttachment = [];
        }
      }

      const chatNew = {
        from_id: from,
        to_id: to,
        patientId: patientId || null,
        doctorId: doctorId || null,
        case_id: resolvedCaseId,
        message: chatMessage,
        created_time: utcDateString,
        attachment: chatAttachment ? JSON.stringify(chatAttachment) : null,
        messageType: messageType || MESSAGE_TYPE.TEXT,
        type: messageType || MESSAGE_TYPE.TEXT,
        is_read: "1",
        is_chat: "1",
        metadata: chatMetaData ? JSON.stringify(chatMetaData) : null,
        senderRole: senderRole || null,
        receiverRole: receiverRole || null,
        chat_mode: chat_mode || null,
      };

      const [insertedId] = await db("chat").insert(chatNew);
      const id = insertedId;

      const fromUserObj = {
        id: fromU.user_id,
        first_name: fromU.first_name,
        last_name: fromU.last_name,
        image: fromUserProfile || fromU.image || "",
        role: fromU.role || "",
      };

      const toUserObj = {
        id: toU.user_id,
        first_name: toU.first_name,
        last_name: toU.last_name,
        image: toUserProfile || toU.image || "",
        role: toU.role || "",
      };

      const patientObj = patientData
        ? {
            id: patientData.user_id,
            first_name: patientUserName || patientData.first_name,
            last_name: patientData.last_name,
            image: patientUserProfile || patientData.image || "",
            email: patientData.email || "",
            role: patientData.role || "",
          }
        : null;

      const doctorObj = doctorData
        ? {
            id: doctorData.user_id,
            first_name: doctorUserName || doctorData.first_name,
            last_name: doctorData.last_name,
            image: doctorUserProfile || doctorData.image || "",
            email: doctorData.email || "",
            role: doctorData.role || "",
          }
        : null;

      if (ackCallback) {
        ackCallback({
          status: true,
          msgId: id,
          chatType,
          chat_mode: chat_mode || chatType,
          case_id: resolvedCaseId,
        });
      }

      const senderFullName =
        fromUserName ||
        `${fromU.first_name || ""} ${fromU.last_name || ""}`.trim();
      const notificationTitle = buildNotificationTitle(
        senderRole,
        senderFullName,
      );
      const notificationBody = buildNotificationBody(
        senderRole,
        senderFullName,
        chatMessage,
      );

      const responseData = {
        ACTION: "MESSAGE",
        fromUser: JSON.stringify(fromUserObj),
        toUser: JSON.stringify(toUserObj),
        patient: patientObj ? JSON.stringify(patientObj) : null,
        doctor: doctorObj ? JSON.stringify(doctorObj) : null,
        message: chatMessage,
        messageType: messageType || MESSAGE_TYPE.TEXT,
        attachment: JSON.stringify(chatAttachment || []),
        metaData: JSON.stringify(chatMetaData),
        insertedMessage: String(id),
        chatType,
        patientId: patientId || null,
        doctorId: doctorId || null,
        case_id: resolvedCaseId,
        senderRole,
        receiverRole,
        chat_mode: chat_mode || chatType,
        title: notificationTitle,
        body: notificationBody,
        created_time: utcDateString,
      };

      const userTokens = await db("fcmtoken")
        .where("user_id", to)
        .select("token");
      const tokenList = userTokens.map((t) => t.token).filter(Boolean);

      if (tokenList.length > 0) {
        const fcmMessages = tokenList.map((token) => ({
          token,
          data: {
            DocotorName: JSON.stringify(notificationTitle),
            fromUser: JSON.stringify(fromUserObj),
            toUser: JSON.stringify(toUserObj),
            patient: patientObj ? JSON.stringify(patientObj) : null,
            doctor: doctorObj ? JSON.stringify(doctorObj) : null,
            ACTION: JSON.stringify("MESSAGE"),
            insertedMessage: String(id),
            messageType: JSON.stringify(messageType || MESSAGE_TYPE.TEXT),
            attachment: JSON.stringify(chatAttachment || []),
            message: JSON.stringify(chatMessage),
            metaData: JSON.stringify(chatMetaData),
            senderRole: JSON.stringify(senderRole),
            receiverRole: JSON.stringify(receiverRole),
            chatType,
            chat_mode: chat_mode || chatType,
            case_id: resolvedCaseId != null ? String(resolvedCaseId) : null,
            title: JSON.stringify(notificationTitle),
            body: JSON.stringify(notificationBody),
          },
          notification: {
            title: notificationTitle,
            body: notificationBody,
          },
        }));

        await sendPushNotificationMessage(fcmMessages);
      }

      io.emit("notification-success", responseData);
      io.emit(`receive-message-${to}`, responseData);
      io.emit("pushnotification", responseData);
    } catch (error) {
      console.error("[role-message] Error:", error);
      socket.emit("notification-error", {
        status: false,
        message: "Error processing role-message",
      });
      if (ackCallback) ackCallback({ status: false, error: error.message });
    }
  });

  socket.on("upload-and-send", async (data, ackCallback) => {
    try {
      let {
        from,
        to,
        messageType,
        filePath,
        iscaregiver,
        metadata,
        metaData,
        patientId,
        doctorId,
        case_id,
        caseId,
        chat_mode,
        senderRole: senderRoleFromFrontend,
        receiverRole: receiverRoleFromFrontend,
        fromUserRole,
        toUserRole,
        fromUserName,
        fromUserProfile,
        toUserName,
        toUserProfile,
      } = data;

      if (!senderRoleFromFrontend && fromUserRole)
        senderRoleFromFrontend = fromUserRole;
      if (!receiverRoleFromFrontend && toUserRole)
        receiverRoleFromFrontend = toUserRole;

      if (!filePath) {
        const errorMsg = "filePath is required for upload-and-send";
        socket.emit("notification-error", { status: false, message: errorMsg });
        if (ackCallback) ackCallback({ status: false, error: errorMsg });
        return;
      }

      if (!ATTACHMENT_TYPES.includes(messageType)) {
        const errorMsg = `Invalid messageType for upload: ${messageType}. Use: ${ATTACHMENT_TYPES.join(", ")}`;
        socket.emit("notification-error", { status: false, message: errorMsg });
        if (ackCallback) ackCallback({ status: false, error: errorMsg });
        return;
      }

      from = parseInt(from) || from;
      to = parseInt(to) || to;

      let uploadedUrl = null;
      try {
        const uploadResult = await uploadFileToServer(
          filePath,
          messageType,
          baseUrl || `http://localhost:${process.env.PORT || 3001}`,
        );
        uploadedUrl = uploadResult.url || uploadResult.data?.url || null;
      } catch (uploadErr) {
        console.error("[upload-and-send] Upload failed:", uploadErr.message);
        socket.emit("notification-error", {
          status: false,
          message: "File upload failed",
        });
        if (ackCallback)
          ackCallback({ status: false, error: "File upload failed" });
        return;
      }

      const chatMessage =
        messageType === MESSAGE_TYPE.PDF ? path.basename(filePath) : "";

      socket.emit(
        "send-message",
        {
          from,
          to,
          message: chatMessage,
          messageType,
          attachment: uploadedUrl ? [uploadedUrl] : [],
          iscaregiver: iscaregiver || "",
          metadata: metadata || null,
          metaData: metaData || null,
          patientId: patientId || null,
          doctorId: doctorId || null,
          case_id: case_id || caseId || null,
          chat_mode: chat_mode || messageType,
          senderRole: senderRoleFromFrontend,
          receiverRole: receiverRoleFromFrontend,
          fromUserName,
          fromUserProfile,
          toUserName,
          toUserProfile,
        },
        ackCallback,
      );
    } catch (error) {
      console.error("[upload-and-send] Error:", error);
      socket.emit("notification-error", {
        status: false,
        message: "Error in upload-and-send",
      });
      if (ackCallback) ackCallback({ status: false, error: error.message });
    }
  });

  socket.on("validate-chat", async (data, ackCallback) => {
    try {
      const { senderRole, receiverRole, chat_mode } = data;
      const validation = validateChatRules({
        senderRole,
        receiverRole,
        chat_mode,
      });

      if (ackCallback) {
        ackCallback({
          valid: validation.valid,
          errors: validation.errors,
          chatType: `${senderRole}-${receiverRole}`,
        });
      }
    } catch (error) {
      console.error("[validate-chat] Error:", error);
      if (ackCallback) ackCallback({ valid: false, errors: [error.message] });
    }
  });

  socket.on("invite-case", async (data, ackCallback) => {
    try {
      const result = await caseCtx.inviteCase(data || {});
      if (result.httpStatus >= 400) {
        socket.emit("notification-error", {
          status: false,
          message: result.body.message,
        });
      }
      if (ackCallback) ackCallback(result.body);
      const cid = data?.case_id || data?.caseId;
      if (result.emit?.user_id)
        io.emit(`case-invite-${result.emit.user_id}`, result.body);
      if (result.emit?.case_id)
        io.emit(`case-invite-${result.emit.case_id}`, result.body);
      else if (cid) io.emit(`case-invite-${cid}`, result.body);
    } catch (error) {
      console.error("[invite-case] Error:", error);
      socket.emit("notification-error", {
        status: false,
        message: "Error sending case invite",
      });
      if (ackCallback)
        ackCallback({
          status: false,
          message: "Error sending case invite",
          error: error.message,
        });
    }
  });

  socket.on("accept-case-invite", async (data, ackCallback) => {
    try {
      const result = await caseCtx.acceptCaseInvite(data || {});
      if (result.httpStatus >= 400) {
        socket.emit("notification-error", {
          status: false,
          message: result.body.message,
        });
      }
      if (ackCallback) ackCallback(result.body);
      if (result.emit) {
        io.emit(`case-invite-accepted-${result.emit.sender_id}`, result.body);
        io.emit(`case-invite-accepted-${result.emit.case_id}`, result.body);
        io.emit(`case-invite-accepted-${result.emit.user_id}`, result.body);
      }
    } catch (error) {
      console.error("[accept-case-invite] Error:", error);
      socket.emit("notification-error", {
        status: false,
        message: "Error accepting case invite",
      });
      if (ackCallback)
        ackCallback({
          status: false,
          message: "Error accepting case invite",
          error: error.message,
        });
    }
  });

  socket.on("list-case-invites", async (data, ackCallback) => {
    try {
      const result = await caseCtx.listCaseInvites(data || {});
      if (result.httpStatus >= 400) {
        socket.emit("notification-error", {
          status: false,
          message: result.body.message,
        });
        if (ackCallback) ackCallback(result.body);
        return;
      }
      if (ackCallback) ackCallback(result.body);
      if (result.emit?.case_id)
        io.emit(`case-invite-list-${result.emit.case_id}`, result.body);
    } catch (error) {
      console.error("[list-case-invites] Error:", error);
      socket.emit("notification-error", {
        status: false,
        message: "Error listing case invites",
      });
      if (ackCallback)
        ackCallback({
          status: false,
          message: "Error listing case invites",
          error: error.message,
        });
    }
  });

  function parseMessageAttachment(messageType, attachment) {
    if (!ATTACHMENT_TYPES.includes(messageType)) return null;

    if (Array.isArray(attachment)) return attachment;
    if (typeof attachment === "string") return [attachment];
    return [];
  }

  async function processSendMessageCase(data, ackCallback) {
    let {
      from,
      message,
      messageType,
      attachment,
      metadata,
      metaData,
      patientId,
      doctorId,
      case_id,
      caseId,
      patientUserName,
      patientUserProfile,
      doctorUserName,
      doctorUserProfile,
      chat_mode,
      senderRole: senderRoleFromFrontend,
      fromUserRole,
      fromUserName,
      fromUserProfile,
      actingId,
    } = data;

    if (!senderRoleFromFrontend && fromUserRole)
      senderRoleFromFrontend = fromUserRole;

    if (!messageType) messageType = MESSAGE_TYPE.TEXT;
    if (!chat_mode) chat_mode = messageType;

    const resolvedCaseId = case_id || caseId || null;

    if (!from && from !== 0) {
      const errorMsg = "From user ID is required";
      socket.emit("notification-error", { status: false, message: errorMsg });
      if (ackCallback) ackCallback({ status: false, error: errorMsg });
      return;
    }

    if (!resolvedCaseId) {
      const errorMsg = "case_id is required";
      socket.emit("notification-error", { status: false, message: errorMsg });
      if (ackCallback) ackCallback({ status: false, error: errorMsg });
      return;
    }

    from = parseInt(from) || from;

    const chatAttachment = parseMessageAttachment(messageType, attachment);
    const chatMessage = message || "";

    if (!chatMessage && (!chatAttachment || chatAttachment.length === 0)) {
      const errorMsg = "message or attachment is required";
      socket.emit("notification-error", { status: false, message: errorMsg });
      if (ackCallback) ackCallback({ status: false, error: errorMsg });
      return;
    }

    const fromU = await caseCtx.resolveProfile(from, {
      name: fromUserName,
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email,
      image: fromUserProfile,
      role: senderRoleFromFrontend || fromUserRole || "user",
    });

    let patientData = null;
    let doctorData = null;

    if (patientId) {
      patientData = await caseCtx.resolveProfile(parseInt(patientId), {
        name: patientUserName,
        image: patientUserProfile,
        role: "patient",
      });
    }

    if (doctorId) {
      doctorData = await caseCtx.resolveProfile(parseInt(doctorId), {
        name: doctorUserName,
        image: doctorUserProfile,
        role: "doctor",
      });
    }

    const senderRole = senderRoleFromFrontend || fromU.role || "";
    const chatMetaData = metaData || metadata || {};
    const utcDateString = new Date().toISOString();

    await ensureIsSeenColumn(db);
    await ensureActingIdColumn(db);

    const resolvedActingId = resolveActingId(actingId);
    const recipientIds = await caseCtx.getCaseMemberIds(resolvedCaseId, from);
    const isSeenState = {
      SENT: [Number(from)].filter((n) => !Number.isNaN(n)),
      RECEIVED: [],
      READ: [],
    };

    const chatNew = {
      from_id: from,
      to_id: null,
      patientId: patientId || null,
      doctorId: doctorId || null,
      case_id: resolvedCaseId,
      message: chatMessage,
      created_time: utcDateString,
      attachment: chatAttachment ? JSON.stringify(chatAttachment) : null,
      messageType: messageType || MESSAGE_TYPE.TEXT,
      type: messageType || MESSAGE_TYPE.TEXT,
      is_read: "1",
      is_seen: JSON.stringify(isSeenState),
      is_chat: "1",
      metadata: chatMetaData ? JSON.stringify(chatMetaData) : null,
      senderRole: senderRole || null,
      receiverRole: null,
      chat_mode: chat_mode || null,
      actingId: resolvedActingId,
    };

    const [insertedId] = await db("chat").insert(chatNew);
    const id = insertedId;

    const fromUserObj = {
      id: fromU.user_id,
      first_name: fromU.first_name,
      last_name: fromU.last_name,
      image: fromUserProfile || fromU.image || "",
      role: fromU.role || "",
    };

    const patientObj = patientData
      ? {
          id: patientData.user_id,
          first_name: patientUserName || patientData.first_name,
          last_name: patientData.last_name,
          image: patientUserProfile || patientData.image || "",
          email: patientData.email || "",
          role: patientData.role || "",
        }
      : null;

    const doctorObj = doctorData
      ? {
          id: doctorData.user_id,
          first_name: doctorUserName || doctorData.first_name,
          last_name: doctorData.last_name,
          image: doctorUserProfile || doctorData.image || "",
          email: doctorData.email || "",
          role: doctorData.role || "",
        }
      : null;

    if (ackCallback) {
      ackCallback({
        status: true,
        msgId: id,
        case_id: resolvedCaseId,
        notified: recipientIds,
        ACTION: "CASE_MESSAGE",
      });
    }

    const senderFullName =
      fromUserName ||
      `${fromU.first_name || ""} ${fromU.last_name || ""}`.trim();
    const notificationTitle = buildNotificationTitle(
      senderRole,
      senderFullName,
    );
    const notificationBody = buildNotificationBody(
      senderRole,
      senderFullName,
      chatMessage,
    );

    const responseData = {
      ACTION: "CASE_MESSAGE",
      fromUser: JSON.stringify(fromUserObj),
      toUser: null,
      patient: patientObj ? JSON.stringify(patientObj) : null,
      doctor: doctorObj ? JSON.stringify(doctorObj) : null,
      message: chatMessage,
      messageType: messageType || MESSAGE_TYPE.TEXT,
      attachment: JSON.stringify(chatAttachment || []),
      metaData: JSON.stringify(chatMetaData),
      insertedMessage: String(id),
      chatType: "case",
      patientId: patientId || null,
      doctorId: doctorId || null,
      case_id: resolvedCaseId,
      senderRole,
      receiverRole: null,
      chat_mode: chat_mode || messageType,
      title: notificationTitle,
      body: notificationBody,
      created_time: utcDateString,
      is_seen: isSeenState,
      actingId: resolvedActingId,
      notified: recipientIds,
    };

    if (recipientIds.length > 0) {
      const tokenRows = await db("fcmtoken")
        .whereIn("user_id", recipientIds)
        .select("token");
      const tokenList = tokenRows.map((t) => t.token).filter(Boolean);

      if (tokenList.length > 0) {
        const fcmMessages = tokenList.map((token) => ({
          token,
          data: {
            DocotorName: JSON.stringify(notificationTitle),
            fromUser: JSON.stringify(fromUserObj),
            toUser: null,
            patient: patientObj ? JSON.stringify(patientObj) : null,
            doctor: doctorObj ? JSON.stringify(doctorObj) : null,
            ACTION: JSON.stringify("CASE_MESSAGE"),
            insertedMessage: String(id),
            messageType: JSON.stringify(messageType || MESSAGE_TYPE.TEXT),
            attachment: JSON.stringify(chatAttachment || []),
            message: JSON.stringify(chatMessage),
            metaData: JSON.stringify(chatMetaData),
            senderRole: JSON.stringify(senderRole),
            receiverRole: null,
            chatType: "case",
            chat_mode: chat_mode || messageType,
            case_id: String(resolvedCaseId),
            actingId:
              resolvedActingId == null ? null : String(resolvedActingId),
            title: JSON.stringify(notificationTitle),
            body: JSON.stringify(notificationBody),
          },
          notification: {
            title: notificationTitle,
            body: notificationBody,
          },
        }));

        await sendPushNotificationMessage(fcmMessages);
      }
    }

    await invalidateCaseCache(resolvedCaseId);

    io.emit(`receive-case-message-${resolvedCaseId}`, responseData);

    for (const userId of recipientIds) {
      io.emit(`receive-case-message-${userId}`, responseData);
      io.emit(`receive-message-${userId}`, responseData);
    }

    io.emit("notification-success", responseData);
    io.emit("pushnotification", responseData);
  }

  socket.on("send-message-case", async (data, ackCallback) => {
    try {
      await processSendMessageCase(data, ackCallback);
    } catch (error) {
      console.error("[send-message-case] Error:", error);
      socket.emit("notification-error", {
        status: false,
        message: "Error processing case message",
      });
      if (ackCallback) ackCallback({ status: false, error: error.message });
    }
  });

  socket.on("seen-message-case", async (data, ackCallback) => {
    try {
      const result = await caseCtx.markCaseMessageSeen(data || {});

      if (result.httpStatus >= 400) {
        socket.emit("notification-error", {
          status: false,
          message: result.body.message,
        });
        if (ackCallback) ackCallback(result.body);
        return;
      }

      if (ackCallback) ackCallback(result.body);

      if (result.emit) {
        const {
          case_id: emitCaseId,
          message_id: emitMessageId,
          user_id: emitUserId,
        } = result.emit;
        io.emit(`case-message-seen-${emitMessageId}`, result.body);
        if (emitUserId != null) {
          io.emit(`case-message-seen-${emitUserId}`, result.body);
        }

        if (emitCaseId) {
          io.emit(`case-message-seen-${emitCaseId}`, result.body);
          const memberIds = await caseCtx.getCaseMemberIds(emitCaseId);
          for (const memberId of memberIds) {
            io.emit(`case-message-seen-${memberId}`, result.body);
          }
        }
      }
    } catch (error) {
      console.error("[seen-message-case] Error:", error);
      socket.emit("notification-error", {
        status: false,
        message: "Error marking case message as seen",
      });
      if (ackCallback) ackCallback({ status: false, error: error.message });
    }
  });

  socket.on("upload-and-send-case", async (data, ackCallback) => {
    try {
      let {
        from,
        messageType,
        filePath,
        metadata,
        metaData,
        patientId,
        doctorId,
        case_id,
        caseId,
        chat_mode,
        senderRole: senderRoleFromFrontend,
        fromUserRole,
        fromUserName,
        fromUserProfile,
        patientUserName,
        patientUserProfile,
        doctorUserName,
        doctorUserProfile,
      } = data;

      if (!senderRoleFromFrontend && fromUserRole)
        senderRoleFromFrontend = fromUserRole;

      if (!filePath) {
        const errorMsg = "filePath is required for upload-and-send-case";
        socket.emit("notification-error", { status: false, message: errorMsg });
        if (ackCallback) ackCallback({ status: false, error: errorMsg });
        return;
      }

      if (!ATTACHMENT_TYPES.includes(messageType)) {
        const errorMsg = `Invalid messageType for upload: ${messageType}. Use: ${ATTACHMENT_TYPES.join(", ")}`;
        socket.emit("notification-error", { status: false, message: errorMsg });
        if (ackCallback) ackCallback({ status: false, error: errorMsg });
        return;
      }

      let uploadedUrl = null;
      try {
        const uploadResult = await uploadFileToServer(
          filePath,
          messageType,
          baseUrl || `http://localhost:${process.env.PORT || 3001}`,
        );
        uploadedUrl = uploadResult.url || uploadResult.data?.url || null;
      } catch (uploadErr) {
        console.error(
          "[upload-and-send-case] Upload failed:",
          uploadErr.message,
        );
        socket.emit("notification-error", {
          status: false,
          message: "File upload failed",
        });
        if (ackCallback)
          ackCallback({ status: false, error: "File upload failed" });
        return;
      }

      const chatMessage =
        messageType === MESSAGE_TYPE.PDF ? path.basename(filePath) : "";

      await processSendMessageCase(
        {
          from,
          message: chatMessage,
          messageType,
          attachment: uploadedUrl ? [uploadedUrl] : [],
          metadata: metadata || null,
          metaData: metaData || null,
          patientId: patientId || null,
          doctorId: doctorId || null,
          case_id: case_id || caseId || null,
          chat_mode: chat_mode || messageType,
          senderRole: senderRoleFromFrontend,
          fromUserName,
          fromUserProfile,
          patientUserName,
          patientUserProfile,
          doctorUserName,
          doctorUserProfile,
        },
        ackCallback,
      );
    } catch (error) {
      console.error("[upload-and-send-case] Error:", error);
      socket.emit("notification-error", {
        status: false,
        message: "Error in upload-and-send-case",
      });
      if (ackCallback) ackCallback({ status: false, error: error.message });
    }
  });

  async function fetchCaseMessageHistory({
    case_id,
    patientId,
    doctorId,
    user_id,
    userId,
  }) {
    const resolvedUserId = user_id || userId;

    const query = db("chat AS c")
      .leftJoin("profile AS p_from", "p_from.user_id", "c.from_id")
      .leftJoin("profile AS p_to", "p_to.user_id", "c.to_id")
      .leftJoin("profile AS p_patient", "p_patient.user_id", "c.patientId")
      .leftJoin("profile AS p_doctor", "p_doctor.user_id", "c.doctorId")
      .where("c.case_id", case_id)
      .whereNotNull("c.case_id");

    if (patientId) {
      query.andWhere("c.patientId", patientId);
    }

    if (doctorId) {
      query.andWhere("c.doctorId", doctorId);
    }

    if (resolvedUserId) {
      query.andWhere(function () {
        this.where("c.from_id", resolvedUserId).orWhere(
          "c.to_id",
          resolvedUserId,
        );
      });
    }

    const rows = await query
      .select(
        "c.*",
        "p_from.user_id AS from_user_id",
        "p_from.first_name AS from_first_name",
        "p_from.last_name AS from_last_name",
        "p_to.user_id AS to_user_id",
        "p_to.first_name AS to_first_name",
        "p_to.last_name AS to_last_name",
        "p_patient.user_id AS patient_user_id",
        "p_patient.first_name AS patient_first_name",
        "p_patient.last_name AS patient_last_name",
        "p_doctor.user_id AS doctor_user_id",
        "p_doctor.first_name AS doctor_first_name",
        "p_doctor.last_name AS doctor_last_name",
      )
      .orderBy("c.id", "desc");

    return rows.map((row) => ({
      ...row,
      is_seen: parseIsSeen(row.is_seen),
    }));
  }

  function buildCaseHistoryChannel(case_id, patientId) {
    if (patientId) {
      return `send-message-case-history-${case_id}-${patientId}`;
    }
    return `send-message-case-history-${case_id}`;
  }

  socket.on("send-message-case-history", async (data, ackCallback) => {
    const { case_id, caseId, patientId, doctorId, user_id, userId, refresh } =
      data || {};
    const resolvedCaseId = case_id || caseId;
    const resolvedUserId = user_id || userId;

    try {
      if (!resolvedCaseId) {
        throw new Error("case_id is required");
      }

      const channel = buildCaseHistoryChannel(resolvedCaseId, patientId);
      const cachePayload = {
        case_id: resolvedCaseId,
        patientId: patientId || null,
        doctorId: doctorId || null,
        user_id: resolvedUserId || null,
      };

      const response = await withCache({
        endpoint: "send-message-case-history",
        payload: cachePayload,
        caseId: resolvedCaseId,
        skipCache: Boolean(refresh),
        fetchFn: async () => {
          const history = await fetchCaseMessageHistory({
            case_id: resolvedCaseId,
            patientId,
            doctorId,
            user_id: resolvedUserId,
            userId: resolvedUserId,
          });

          const caseUsers = await caseCtx.getCaseUsers(
            resolvedCaseId,
            "accepted",
          );

          return {
            status: true,
            history,
            users: caseUsers.users,
            case_id: resolvedCaseId,
          };
        },
      });

      if (ackCallback) ackCallback(response);

      io.emit(channel, { history: response.history, _cache: response._cache });
    } catch (error) {
      console.error("[send-message-case-history] Error:", error);
      socket.emit("notification-error", {
        status: false,
        message: "Error fetching case message history",
      });
      if (ackCallback) ackCallback({ status: false, error: error.message });

      if (resolvedCaseId) {
        const channel = buildCaseHistoryChannel(resolvedCaseId, patientId);
        io.emit(channel, {
          message: "Error in fetching case message history",
          error: error.message,
        });
      }
    }
  });

  socket.on("get-case-users", async (data, ackCallback) => {
    try {
      const result = await caseCtx.fetchCaseUsers(data || {});
      if (result.httpStatus >= 400) {
        socket.emit("notification-error", {
          status: false,
          message: result.body.message,
        });
        if (ackCallback) ackCallback(result.body);
        return;
      }
      if (ackCallback) ackCallback(result.body);
      if (result.emit?.case_id)
        io.emit(`case-users-${result.emit.case_id}`, result.body);
    } catch (error) {
      console.error("[get-case-users] Error:", error);
      socket.emit("notification-error", {
        status: false,
        message: "Error fetching case users",
      });
      if (ackCallback) ackCallback({ status: false, error: error.message });
    }
  });
}

module.exports = {
  registerChatHandlers,
  createCaseApiRouter,
};
