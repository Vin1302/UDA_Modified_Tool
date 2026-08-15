/* Run once against a SQL Server instance using an account permitted to create databases. */
USE master;
GO
IF DB_ID(N'ClaimSphereDemo') IS NULL CREATE DATABASE ClaimSphereDemo;
GO
USE ClaimSphereDemo;
GO

CREATE TABLE dbo.Member (
  MemberId INT IDENTITY(1,1) PRIMARY KEY,
  MemberNumber VARCHAR(30) NOT NULL UNIQUE,
  FirstName VARCHAR(80) NOT NULL,
  LastName VARCHAR(80) NOT NULL,
  DateOfBirth DATE NOT NULL,
  GenderCode CHAR(1) NOT NULL,
  EmailAddress VARCHAR(150) NULL,
  PhoneNumber VARCHAR(30) NULL,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.MemberAddress (
  AddressId INT IDENTITY(1,1) PRIMARY KEY,
  MemberId INT NOT NULL REFERENCES dbo.Member(MemberId),
  AddressLine1 VARCHAR(150) NOT NULL,
  City VARCHAR(80) NOT NULL,
  StateCode CHAR(2) NOT NULL,
  ZipCode VARCHAR(12) NOT NULL,
  IsCurrent BIT NOT NULL DEFAULT 1
);
CREATE TABLE dbo.Provider (
  ProviderId INT IDENTITY(1,1) PRIMARY KEY,
  Npi VARCHAR(10) NOT NULL UNIQUE,
  ProviderName VARCHAR(150) NOT NULL,
  Specialty VARCHAR(100) NULL
);
CREATE TABLE dbo.MemberEnrollment (
  EnrollmentId INT IDENTITY(1,1) PRIMARY KEY,
  MemberId INT NOT NULL REFERENCES dbo.Member(MemberId),
  PlanCode VARCHAR(30) NOT NULL,
  CoverageStartDate DATE NOT NULL,
  CoverageEndDate DATE NULL,
  PrimaryProviderId INT NULL REFERENCES dbo.Provider(ProviderId),
  EnrollmentStatus VARCHAR(20) NOT NULL
);
CREATE TABLE dbo.MemberVisit (
  VisitId INT IDENTITY(1,1) PRIMARY KEY,
  MemberId INT NOT NULL REFERENCES dbo.Member(MemberId),
  ProviderId INT NOT NULL REFERENCES dbo.Provider(ProviderId),
  VisitDate DATETIME2 NOT NULL,
  VisitType VARCHAR(50) NOT NULL,
  DiagnosisCode VARCHAR(12) NULL
);
GO

INSERT dbo.Member (MemberNumber, FirstName, LastName, DateOfBirth, GenderCode, EmailAddress, PhoneNumber)
VALUES ('CS-10001','Asha','Sharma','1988-04-12','F','asha.sharma@example.test','555-0101'),
       ('CS-10002','Rahul','Mehta','1979-11-03','M','rahul.mehta@example.test','555-0102'),
       ('CS-10003','Priya','Nair','1992-07-21','F','priya.nair@example.test','555-0103');
INSERT dbo.MemberAddress (MemberId, AddressLine1, City, StateCode, ZipCode)
VALUES (1,'12 Lake View Road','Austin','TX','78701'), (2,'45 Market Street','Dallas','TX','75201'), (3,'8 Garden Lane','Houston','TX','77002');
INSERT dbo.Provider (Npi, ProviderName, Specialty)
VALUES ('1234567890','Dr. Elena Ruiz','Family Medicine'), ('2345678901','Dr. Marcus Lee','Cardiology');
INSERT dbo.MemberEnrollment (MemberId, PlanCode, CoverageStartDate, PrimaryProviderId, EnrollmentStatus)
VALUES (1,'GOLD-2026','2026-01-01',1,'ACTIVE'), (2,'SILVER-2026','2026-01-01',2,'ACTIVE'), (3,'GOLD-2026','2026-02-01',1,'ACTIVE');
INSERT dbo.MemberVisit (MemberId, ProviderId, VisitDate, VisitType, DiagnosisCode)
VALUES (1,1,'2026-02-05T09:30:00','Annual wellness','Z00.00'), (2,2,'2026-02-10T14:00:00','Cardiology follow-up','I10'), (3,1,'2026-02-12T11:15:00','Primary care','J06.9');
GO

CREATE VIEW dbo.vw_ClaimSphereMemberExport AS
SELECT m.MemberNumber, m.FirstName, m.LastName, m.DateOfBirth, m.GenderCode,
       m.EmailAddress, m.PhoneNumber, a.AddressLine1, a.City, a.StateCode, a.ZipCode,
       e.PlanCode, e.CoverageStartDate, e.EnrollmentStatus,
       p.Npi AS PrimaryProviderNpi, p.ProviderName AS PrimaryProviderName
FROM dbo.Member m
JOIN dbo.MemberAddress a ON a.MemberId = m.MemberId AND a.IsCurrent = 1
JOIN dbo.MemberEnrollment e ON e.MemberId = m.MemberId AND e.EnrollmentStatus = 'ACTIVE'
LEFT JOIN dbo.Provider p ON p.ProviderId = e.PrimaryProviderId;
GO
