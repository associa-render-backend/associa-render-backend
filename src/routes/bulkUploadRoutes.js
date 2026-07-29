const express = require('express');
const router = express.Router();

const multer = require('multer');
const XLSX = require('xlsx');

const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');
const { authorizeRoles, requireOrganization } = require('../middleware/authorizationMiddleware');
const { writeAuditEvent } = require('../services/auditService');

const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:10 * 1024 * 1024 } });

router.use(authMiddleware, requireOrganization, authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER', 'DATA_ENTRY'));

function normalizeExcelDate(value) {
    try {
        if (!value) return null;
        if (typeof value === 'number') {
            const excelDate = XLSX.SSF.parse_date_code(value);
            return `${excelDate.y}-${String(excelDate.m).padStart(2, '0')}-${String(excelDate.d).padStart(2, '0')}`;
        }
        if (value instanceof Date) return value.toISOString().split('T')[0];
        const str = String(value).trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
            const parts = str.split('/');
            return `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
        if (/^\d{2}-\d{2}-\d{4}$/.test(str)) {
            const parts = str.split('-');
            return `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
        const parsed = new Date(str);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
        return null;
    } catch {
        return null;
    }
}

function text(value, max = 255) {
    return String(value || '').trim().slice(0, max);
}

function fullName(row) {
    return [row.Surname, row.FirstName, row.OtherName].map(x => text(x, 200)).filter(Boolean).join(' ') || text(row.MemberNo, 100);
}

function actorName(req) {
    return req.user?.fullName || req.user?.email || 'System User';
}

function readRows(req) {
    if (!req.file) {
        const error = new Error('No file uploaded');
        error.statusCode = 400;
        throw error;
    }
    const workbook = XLSX.read(req.file.buffer, { type:'buffer' });
    const sheetName = workbook.SheetNames[0];
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { raw:true });
}

router.post('/members', upload.single('file'), async (req, res) => {
    try {
        const rows = readRows(req);
        let created = 0;
        let skipped = 0;
        for (const row of rows) {
            try {
                const memberNo = text(row.MemberNo, 100);
                if (!memberNo) { skipped++; continue; }
                const existing = await db.query(`SELECT "Id" FROM "Members" WHERE "OrganizationId" = $1 AND ("MemberNo" = $2 OR "MemberNumber" = $2) LIMIT 1`, [req.organizationId, memberNo]);
                if (existing.rows.length > 0) { skipped++; continue; }
                await db.query(`
                    INSERT INTO "Members"
                    ("OrganizationId", "MemberNumber", "MemberNo", "FullName", "Surname", "FirstName", "OtherName", "Phone", "Email", "Village", "Branch", "Zone", "Status", "CreditBalance", "CreatedAt")
                    VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE',0,CURRENT_TIMESTAMP)
                `, [req.organizationId, memberNo, fullName(row), text(row.Surname, 200), text(row.FirstName, 200), text(row.OtherName, 200), text(row.Phone, 100), text(row.Email, 255), text(row.Village, 200), text(row.Branch, 200), text(row.Zone, 200)]);
                created++;
            } catch (err) { console.error(err); skipped++; }
        }
        await writeAuditEvent({ req, organizationId:req.organizationId, action:'IMPORT', entityType:'BULK_MEMBERS', entityId:req.file.originalname, summary:`${created} members imported; ${skipped} skipped`, afterData:{ created, skipped, rows:rows.length }, metadata:{ fileName:req.file.originalname } });
        res.json({ success:true, message:`${created} members uploaded successfully. ${skipped} skipped.` });
    } catch (err) { console.error(err); res.status(err.statusCode || 500).json({ success:false, message:err.message }); }
});

router.post('/member-obligations', upload.single('file'), async (req, res) => {
    try {
        const rows = readRows(req);
        const campaignResult = await db.query(`SELECT "Id" FROM "Campaigns" WHERE "OrganizationId" = $1 AND "CampaignCode" = 'INDIVIDUAL' LIMIT 1`, [req.organizationId]);
        if (campaignResult.rows.length === 0) return res.status(500).json({ success:false, message:'INDIVIDUAL campaign not found' });
        const campaignId = campaignResult.rows[0].Id;
        let created = 0;
        let skipped = 0;
        for (const row of rows) {
            try {
                const memberNo = text(row.MemberNo, 100);
                const memberResult = await db.query(`SELECT "Id" FROM "Members" WHERE "OrganizationId" = $1 AND ("MemberNo" = $2 OR "MemberNumber" = $2) LIMIT 1`, [req.organizationId, memberNo]);
                if (memberResult.rows.length === 0) { skipped++; continue; }
                const amount = Number(row.Amount || 0);
                const dueDate = normalizeExcelDate(row.DueDate);
                if (amount <= 0 || !dueDate) { skipped++; continue; }
                await db.query(`
                    INSERT INTO "Obligations"
                    ("OrganizationId", "CampaignId", "MemberId", "AmountDue", "AmountPaid", "WaivedAmount", "CreditBalance", "Balance", "DueDate", "Status", "CreatedAt", "UpdatedAt", "AssignmentType", "ObligationType", "Description")
                    VALUES ($1,$2,$3,$4,0,0,0,$4,$5,'UNPAID',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'INDIVIDUAL',$6,$7)
                `, [req.organizationId, campaignId, memberResult.rows[0].Id, amount, dueDate, text(row.Type || 'OTHER', 100), text(row.Description, 500)]);
                created++;
            } catch (err) { console.error(err); skipped++; }
        }
        await writeAuditEvent({ req, organizationId:req.organizationId, action:'IMPORT', entityType:'BULK_MEMBER_OBLIGATIONS', entityId:req.file.originalname, summary:`${created} obligations imported; ${skipped} skipped`, afterData:{ created, skipped, rows:rows.length }, metadata:{ fileName:req.file.originalname } });
        res.json({ success:true, message:`${created} obligations uploaded successfully. ${skipped} skipped.` });
    } catch (err) { console.error(err); res.status(err.statusCode || 500).json({ success:false, message:err.message }); }
});

router.post('/payments', upload.single('file'), async (req, res) => {
    try {
        const rows = readRows(req);
        let processed = 0;
        let skipped = 0;
        for (const row of rows) {
            try {
                const memberNo = text(row.MemberNo, 100);
                const memberResult = await db.query(`SELECT "Id" FROM "Members" WHERE "OrganizationId" = $1 AND ("MemberNo" = $2 OR "MemberNumber" = $2) LIMIT 1`, [req.organizationId, memberNo]);
                if (memberResult.rows.length === 0) { skipped++; continue; }
                const amount = Number(row.Amount || 0);
                const paymentDate = normalizeExcelDate(row.PaymentDate);
                if (amount <= 0 || !paymentDate) { skipped++; continue; }
                await db.query(`
                    INSERT INTO "Payments"
                    ("OrganizationId", "MemberId", "Amount", "AmountPaid", "PaymentDate", "PaymentMethod", "Reference", "Remarks", "Status", "CreatedBy", "CreatedAt")
                    VALUES ($1,$2,$3,$3,$4,'BULK UPLOAD',$5,'Bulk Upload','POSTED',$6,CURRENT_TIMESTAMP)
                `, [req.organizationId, memberResult.rows[0].Id, amount, paymentDate, text(row.PurposeOfPayment, 500), actorName(req)]);
                processed++;
            } catch (err) { console.error(err); skipped++; }
        }
        await writeAuditEvent({ req, organizationId:req.organizationId, action:'IMPORT', entityType:'BULK_PAYMENTS', entityId:req.file.originalname, summary:`${processed} payments imported; ${skipped} skipped`, afterData:{ processed, skipped, rows:rows.length }, metadata:{ fileName:req.file.originalname } });
        res.json({ success:true, message:`${processed} payments uploaded successfully. ${skipped} skipped.` });
    } catch (err) { console.error(err); res.status(err.statusCode || 500).json({ success:false, message:err.message }); }
});

module.exports = router;
