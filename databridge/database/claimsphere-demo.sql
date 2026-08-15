/* WARNING: This resets the ClaimSphereDemo test database. Do not run against production. */
USE master;
GO
IF DB_ID(N'ClaimSphereDemo') IS NOT NULL
BEGIN
  ALTER DATABASE ClaimSphereDemo SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE ClaimSphereDemo;
END;
GO
CREATE DATABASE ClaimSphereDemo;
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

/* ClaimSphere mapping fixtures. Select these tables explicitly in the UI when
   testing Membership General and Membership Disability layouts. */
CREATE TABLE dbo.ClaimSphereMembershipGeneralSource (
  Member_ID VARCHAR(100) NOT NULL PRIMARY KEY,
  Last_Name VARCHAR(60) NOT NULL,
  First_Name VARCHAR(60) NOT NULL,
  Middle_Initial VARCHAR(16) NULL,
  Gender CHAR(1) NOT NULL,
  Date_Of_Birth DATE NOT NULL,
  Marital_Status_Code VARCHAR(10) NULL,
  Address1 VARCHAR(150) NULL,
  Address2 VARCHAR(150) NULL,
  City VARCHAR(80) NULL,
  County_Code VARCHAR(10) NULL,
  State_Code CHAR(2) NULL,
  Zip_Code VARCHAR(12) NULL,
  Phone_Number VARCHAR(30) NULL,
  Secondary_Phone VARCHAR(30) NULL,
  Email_ID VARCHAR(150) NULL,
  HIXNY_ID VARCHAR(50) NULL,
  Source_System_ID VARCHAR(50) NULL,
  Language_Spoken VARCHAR(50) NULL,
  Language_Written VARCHAR(50) NULL,
  Interpreter_Flag CHAR(1) NULL,
  Medicaid_ID VARCHAR(50) NULL,
  Medicare_ID VARCHAR(50) NULL,
  Employer_ID VARCHAR(50) NULL,
  Employer_Name VARCHAR(150) NULL,
  Date_Of_Death DATE NULL,
  Parent_Last_Name VARCHAR(60) NULL,
  Parent_First_Name VARCHAR(60) NULL,
  Parent_Email_Address VARCHAR(150) NULL,
  SPD_Flag CHAR(1) NULL
);

CREATE TABLE dbo.ClaimSphereMembershipDisabilitySource (
  Member_ID VARCHAR(100) NOT NULL PRIMARY KEY,
  Disability_Status CHAR(2) NOT NULL,
  s CHAR(2) NOT NULL,
  Additional_Col1 VARCHAR(120) NULL,
  Additional_Col2 VARCHAR(120) NULL
);

/* Intentionally similar but non-authoritative tables for AI mapping evaluation. */
CREATE TABLE dbo.MemberMarketingProfile (
  MarketingMemberId VARCHAR(100) NOT NULL PRIMARY KEY,
  PreferredLanguage VARCHAR(50) NULL,
  PreferredEmail VARCHAR(150) NULL,
  OptInFlag BIT NOT NULL DEFAULT 0,
  CampaignStatus VARCHAR(30) NULL
);
CREATE TABLE dbo.LegacyMemberArchive (
  LegacyMemberNumber VARCHAR(100) NOT NULL PRIMARY KEY,
  FullName VARCHAR(160) NULL,
  BirthYear CHAR(4) NULL,
  ArchivedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

INSERT dbo.ClaimSphereMembershipGeneralSource
  (Member_ID, Last_Name, First_Name, Middle_Initial, Gender, Date_Of_Birth, Address1, City, State_Code, Zip_Code, Phone_Number, Email_ID, Source_System_ID, Language_Spoken, Language_Written, Interpreter_Flag, Medicaid_ID, Medicare_ID, Employer_Name, SPD_Flag)
VALUES
  ('CS-10001', 'Sharma', 'Asha', NULL, 'F', '1988-04-12', '12 Lake View Road', 'Austin', 'TX', '78701', '555-0101', 'asha.sharma@example.test', 'ClaimsCore', 'English', 'English', 'N', 'TX-10001', NULL, 'Example Health', 'N'),
  ('CS-10002', 'Mehta', 'Rahul', 'K', 'M', '1979-11-03', '45 Market Street', 'Dallas', 'TX', '75201', '555-0102', 'rahul.mehta@example.test', 'ClaimsCore', 'English', 'English', 'N', NULL, 'M-20002', 'Example Health', 'N');

INSERT dbo.ClaimSphereMembershipDisabilitySource (Member_ID, Disability_Status, s, Additional_Col1)
VALUES ('CS-10001', '01', '04', 'Questionnaire'), ('CS-10002', '02', '06', 'Enrollment status');

INSERT dbo.MemberMarketingProfile (MarketingMemberId, PreferredLanguage, PreferredEmail, OptInFlag, CampaignStatus)
VALUES ('CS-10001', 'Spanish', 'marketing-asha@example.test', 1, 'ACTIVE'), ('CS-10002', 'English', 'marketing-rahul@example.test', 0, 'INACTIVE');

INSERT dbo.LegacyMemberArchive (LegacyMemberNumber, FullName, BirthYear)
VALUES ('LEG-10001', 'Asha Sharma', '1988'), ('LEG-10002', 'Rahul Mehta', '1979');
GO
