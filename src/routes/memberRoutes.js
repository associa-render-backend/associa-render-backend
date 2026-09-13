const express = require('express');
const router = express.Router();

const { sql } =
require('../config/database');

const authMiddleware =
require('../middleware/authMiddleware');

const {
    authorizeRoles,
    requireOrganization
} =
require('../middleware/authorizationMiddleware');

const {
    writeAuditEvent
} =
require('../services/auditService');

router.use(
    authMiddleware,
    requireOrganization
);

router.get(
'/',
async (req, res) => {

try {

    const request =
        new sql.Request();

    request.input(
        'OrganizationId',
        sql.UniqueIdentifier,
        req.organizationId
    );

    const result =
        await request.query(`

            SELECT
                Id,
                MemberNo,
                Surname,
                FirstName,
                OtherName,
                Phone,
                Email,
                Village,
                Branch,
                Zone,
                Status,
                CreditBalance,
                CreatedAt
            FROM Members
            WHERE
                OrganizationId =
                    @OrganizationId
            ORDER BY
                MemberNo,
                Surname,
                FirstName

        `);

    res.json(
        result.recordset
    );

} catch(err) {

    console.error(err);

    res.status(500).json({
        success:false,
        message:
            'Unable to load members'
    });

}

}
);

router.post(
'/',
authorizeRoles(
    'SUPER_ADMIN',
    'ADMIN',
    'DATA_ENTRY'
),
async (req, res) => {

try {

    const memberNo =
        String(
            req.body.MemberNo || ''
        ).trim();

    const surname =
        String(
            req.body.Surname || ''
        ).trim();

    const firstName =
        String(
            req.body.FirstName || ''
        ).trim();

    if (
        !memberNo ||
        !surname ||
        !firstName
    ) {

        return res.status(400).json({
            success:false,
            message:
                'Member number, surname and first name are required'
        });

    }

    const request =
        new sql.Request();

    request.input(
        'OrganizationId',
        sql.UniqueIdentifier,
        req.organizationId
    );

    request.input(
        'MemberNo',
        sql.NVarChar(100),
        memberNo
    );

    request.input(
        'Surname',
        sql.NVarChar(200),
        surname
    );

    request.input(
        'FirstName',
        sql.NVarChar(200),
        firstName
    );

    const optionalFields = [
        ['OtherName', req.body.OtherName, 200],
        ['Phone', req.body.Phone, 100],
        ['Email', req.body.Email, 255],
        ['Village', req.body.Village, 200],
        ['Branch', req.body.Branch, 200],
        ['Zone', req.body.Zone, 200]
    ];

    optionalFields.forEach(
        ([name, value, length]) => {

            request.input(
                name,
                sql.NVarChar(length),
                value
                    ? String(value).trim()
                    : null
            );

        }
    );

    const duplicate =
        await request.query(`

            SELECT TOP 1 Id
            FROM Members
            WHERE
                OrganizationId =
                    @OrganizationId
                AND MemberNo =
                    @MemberNo

        `);

    if (
        duplicate.recordset.length > 0
    ) {

        return res.status(409).json({
            success:false,
            message:
                'Member number already exists in this organization'
        });

    }

    const insertResult =
        await request.query(`

        DECLARE @MemberId
            UNIQUEIDENTIFIER =
            NEWID();

        INSERT INTO Members
        (
            Id,
            OrganizationId,
            MemberNo,
            Surname,
            FirstName,
            OtherName,
            Phone,
            Email,
            Village,
            Branch,
            Zone,
            Status,
            CreatedAt
        )
        VALUES
        (
            @MemberId,
            @OrganizationId,
            @MemberNo,
            @Surname,
            @FirstName,
            @OtherName,
            @Phone,
            @Email,
            @Village,
            @Branch,
            @Zone,
            'ACTIVE',
            GETDATE()
        )

        SELECT @MemberId
            AS MemberId;

    `);

    const memberId =
        insertResult.recordset[0]
        .MemberId;

    await writeAuditEvent({
        req,
        organizationId:
            req.organizationId,
        action:'CREATE',
        entityType:'MEMBER',
        entityId:memberId,
        summary:
            `Member ${memberNo} created`,
        afterData:{
            id:memberId,
            memberNo,
            surname,
            firstName,
            otherName:
                req.body.OtherName || null,
            phone:
                req.body.Phone || null,
            email:
                req.body.Email || null,
            status:'ACTIVE'
        }
    });

    res.status(201).json({
        success:true,
        message:
            'Member created successfully'
    });

} catch(err) {

    console.error(err);

    res.status(500).json({
        success:false,
        message:
            'Unable to create member'
    });

}

}
);

router.put(
'/:id',
authorizeRoles(
    'SUPER_ADMIN',
    'ADMIN',
    'DATA_ENTRY'
),
async (req, res) => {

try {

    const memberNo =
        String(
            req.body.MemberNo || ''
        ).trim();

    const surname =
        String(
            req.body.Surname || ''
        ).trim();

    const firstName =
        String(
            req.body.FirstName || ''
        ).trim();

    if (
        !memberNo ||
        !surname ||
        !firstName
    ) {

        return res.status(400).json({
            success:false,
            message:
                'Member number, surname and first name are required'
        });

    }

    const request =
        new sql.Request();

    request.input(
        'MemberId',
        sql.UniqueIdentifier,
        req.params.id
    );

    request.input(
        'OrganizationId',
        sql.UniqueIdentifier,
        req.organizationId
    );

    request.input(
        'MemberNo',
        sql.NVarChar(100),
        memberNo
    );

    request.input(
        'Surname',
        sql.NVarChar(200),
        surname
    );

    request.input(
        'FirstName',
        sql.NVarChar(200),
        firstName
    );

    request.input(
        'OtherName',
        sql.NVarChar(200),
        req.body.OtherName
            ? String(req.body.OtherName).trim()
            : null
    );

    request.input(
        'Phone',
        sql.NVarChar(100),
        req.body.Phone
            ? String(req.body.Phone).trim()
            : null
    );

    request.input(
        'Email',
        sql.NVarChar(255),
        req.body.Email
            ? String(req.body.Email).trim()
            : null
    );

    request.input(
        'Village',
        sql.NVarChar(200),
        req.body.Village
            ? String(req.body.Village).trim()
            : null
    );

    request.input(
        'Branch',
        sql.NVarChar(200),
        req.body.Branch
            ? String(req.body.Branch).trim()
            : null
    );

    request.input(
        'Zone',
        sql.NVarChar(200),
        req.body.Zone
            ? String(req.body.Zone).trim()
            : null
    );

    const existing =
        await request.query(`

            SELECT TOP 1 *
            FROM Members
            WHERE
                Id = @MemberId
                AND OrganizationId =
                    @OrganizationId

        `);

    if (
        existing.recordset.length === 0
    ) {

        return res.status(404).json({
            success:false,
            message:'Member not found'
        });

    }

    const duplicate =
        await request.query(`

            SELECT TOP 1 Id
            FROM Members
            WHERE
                OrganizationId =
                    @OrganizationId
                AND MemberNo =
                    @MemberNo
                AND Id <> @MemberId

        `);

    if (
        duplicate.recordset.length > 0
    ) {

        return res.status(409).json({
            success:false,
            message:
                'Member number already exists in this organization'
        });

    }

    await request.query(`

        UPDATE Members
        SET
            MemberNo = @MemberNo,
            Surname = @Surname,
            FirstName = @FirstName,
            OtherName = @OtherName,
            Phone = @Phone,
            Email = @Email,
            Village = @Village,
            Branch = @Branch,
            Zone = @Zone
        WHERE
            Id = @MemberId
            AND OrganizationId =
                @OrganizationId

    `);

    await writeAuditEvent({
        req,
        organizationId:
            req.organizationId,
        action:'UPDATE',
        entityType:'MEMBER',
        entityId:req.params.id,
        summary:
            `Member ${memberNo} updated`,
        beforeData:
            existing.recordset[0],
        afterData:{
            memberNo,
            surname,
            firstName,
            otherName:
                req.body.OtherName || null,
            phone:
                req.body.Phone || null,
            email:
                req.body.Email || null,
            village:
                req.body.Village || null,
            branch:
                req.body.Branch || null,
            zone:
                req.body.Zone || null
        }
    });

    res.json({
        success:true,
        message:
            'Member updated successfully'
    });

} catch(err) {

    console.error(err);

    const invalidId =
        /uniqueidentifier/i.test(
            err.message || ''
        );

    res.status(
        invalidId ? 400 : 500
    ).json({
        success:false,
        message:
            invalidId
                ? 'Invalid member ID'
                : 'Unable to update member'
    });

}

}
);

router.delete(
'/:id',
authorizeRoles(
    'SUPER_ADMIN',
    'ADMIN'
),
async (req, res) => {

try {

    const request =
        new sql.Request();

    request.input(
        'MemberId',
        sql.UniqueIdentifier,
        req.params.id
    );

    request.input(
        'OrganizationId',
        sql.UniqueIdentifier,
        req.organizationId
    );

    const memberResult =
        await request.query(`

            SELECT TOP 1 *
            FROM Members
            WHERE
                Id = @MemberId
                AND OrganizationId =
                    @OrganizationId

        `);

    if (
        memberResult.recordset.length ===
        0
    ) {

        return res.status(404).json({
            success:false,
            message:'Member not found'
        });

    }

    const dependencies =
        await request.query(`

            SELECT
                (
                    SELECT COUNT(*)
                    FROM Obligations
                    WHERE
                        MemberId =
                            @MemberId
                        AND OrganizationId =
                            @OrganizationId
                ) +
                (
                    SELECT COUNT(*)
                    FROM Payments
                    WHERE
                        MemberId =
                            @MemberId
                        AND OrganizationId =
                            @OrganizationId
                ) AS FinancialRecords

        `);

    if (
        Number(
            dependencies.recordset[0]
            .FinancialRecords || 0
        ) > 0
    ) {

        return res.status(409).json({
            success:false,
            message:
                'Members with financial records cannot be deleted'
        });

    }

    const result =
        await request.query(`

            DELETE FROM Members
            WHERE
                Id = @MemberId
                AND OrganizationId =
                    @OrganizationId

        `);

    if (result.rowsAffected[0] === 0) {

        return res.status(404).json({
            success:false,
            message:'Member not found'
        });

    }

    await writeAuditEvent({
        req,
        organizationId:
            req.organizationId,
        action:'DELETE',
        entityType:'MEMBER',
        entityId:req.params.id,
        summary:
            `Member ${
                memberResult.recordset[0]
                .MemberNo || req.params.id
            } deleted`,
        beforeData:
            memberResult.recordset[0]
    });

    res.json({
        success:true,
        message:
            'Member deleted successfully'
    });

} catch(err) {

    console.error(err);

    const invalidId =
        /uniqueidentifier/i.test(
            err.message || ''
        );

    res.status(
        invalidId ? 400 : 500
    ).json({
        success:false,
        message:
            invalidId
                ? 'Invalid member ID'
                : 'Unable to delete member'
    });

}

}
);

module.exports = router;
