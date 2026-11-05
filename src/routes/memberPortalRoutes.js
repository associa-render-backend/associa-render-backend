const router = require('express').Router();
const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');

function formatDate(value) {
    if (!value) return '';
    return new Date(value).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric', timeZone:'UTC' });
}

router.get('/summary', authMiddleware, async (req, res) => {
    try {
        if (req.user?.role !== 'MEMBER' || !req.user?.memberId) {
            return res.status(403).json({ success:false, message:'This account is not linked to a member record.' });
        }
        const organizationId = req.user.organizationId;
        const memberId = req.user.memberId;
        const memberResult = await db.query(`
            SELECT m."Id", COALESCE(m."MemberNo", m."MemberNumber") AS "MemberNo",
                   COALESCE(m."FullName", CONCAT_WS(' ', m."FirstName", m."OtherName", m."Surname")) AS "FullName",
                   COALESCE(m."CreditBalance", 0) AS "CreditBalance", o."Name" AS "OrganizationName"
            FROM "Members" m JOIN "Organizations" o ON o."Id" = m."OrganizationId"
            WHERE m."Id" = $1 AND m."OrganizationId" = $2 LIMIT 1
        `, [memberId, organizationId]);
        if (!memberResult.rows.length) return res.status(404).json({ success:false, message:'Linked member record was not found.' });
        const member = memberResult.rows[0];
        const obligationsResult = await db.query(`
            SELECT o."Description", o."DueDate", COALESCE(o."AmountDue",0) AS "AmountDue",
                   COALESCE(o."WaivedAmount",0) AS "WaivedAmount",
                   COALESCE(SUM(pa."Amount"), 0) AS "AmountPaid"
            FROM "Obligations" o
            LEFT JOIN "PaymentAllocations" pa ON pa."ObligationId" = o."Id" AND pa."OrganizationId" = o."OrganizationId"
            LEFT JOIN "Payments" p ON p."Id" = pa."PaymentId" AND COALESCE(p."Status", 'POSTED') = 'POSTED'
            WHERE o."MemberId" = $1 AND o."OrganizationId" = $2
            GROUP BY o."Id", o."Description", o."DueDate", o."AmountDue", o."WaivedAmount"
            ORDER BY o."DueDate" NULLS LAST, o."Description"
        `, [memberId, organizationId]);
        const obligations = obligationsResult.rows.map(item => {
            const balance = Math.max(0, Number(item.AmountDue || 0) - Number(item.AmountPaid || 0) - Number(item.WaivedAmount || 0));
            return { Description:item.Description || 'Member obligation', DueDate:formatDate(item.DueDate), AmountDue:Number(item.AmountDue || 0), AmountPaid:Number(item.AmountPaid || 0), Balance:balance };
        });
        const totalDue = obligations.reduce((sum, item) => sum + item.AmountDue, 0);
        const totalPaid = obligations.reduce((sum, item) => sum + item.AmountPaid, 0);
        const outstanding = obligations.filter(item => item.Balance > 0);
        res.json({ success:true, data:{ associationName:member.OrganizationName, member:{ MemberNo:member.MemberNo, FullName:member.FullName }, summary:{ totalDue, totalPaid, outstandingBalance:outstanding.reduce((sum,item)=>sum+item.Balance,0), creditBalance:Number(member.CreditBalance || 0) }, outstanding } });
    } catch (err) { console.error(err); res.status(500).json({ success:false, message:'Unable to load your member dashboard.' }); }
});
module.exports = router;