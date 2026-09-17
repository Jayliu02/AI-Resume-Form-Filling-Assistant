const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadResumeSchema() {
  const source = fs.readFileSync(
    path.join(__dirname, "../shared/resume-schema.js"),
    "utf8"
  );
  const context = {
    window: {},
    console,
    structuredClone: global.structuredClone,
  };

  vm.createContext(context);
  vm.runInContext(source, context);

  return context.window.ResumeSchema;
}

test("resume schema exposes campus recruiting education and experience fields", () => {
  const schema = loadResumeSchema();
  const catalog = schema.getFieldCatalog({ mode: "max" });
  const template = JSON.parse(schema.createImportTemplateString());

  assert.ok(catalog.some((field) => field.path === "educations.0.educationType"));
  assert.ok(catalog.some((field) => field.path === "educations.0.studyMode"));
  assert.ok(catalog.some((field) => field.path === "educations.0.laboratory"));
  assert.ok(catalog.some((field) => field.path === "educations.0.researchDirection"));
  assert.ok(catalog.some((field) => field.path === "educations.0.advisor"));
  assert.ok(catalog.some((field) => field.path === "internships.0.company"));
  assert.ok(catalog.some((field) => field.path === "campusExperiences.0.organization"));

  assert.ok(Array.isArray(template.internships));
  assert.ok(Array.isArray(template.campusExperiences));
  assert.equal("educationType" in template.educations[0], true);
  assert.equal("studyMode" in template.educations[0], true);
  assert.equal("laboratory" in template.educations[0], true);
  assert.equal("researchDirection" in template.educations[0], true);
  assert.equal("advisor" in template.educations[0], true);
});

test("resume schema normalizes campus recruiting resume data", () => {
  const schema = loadResumeSchema();
  const normalized = schema.normalizeResumeProfile({
    educations: [
      {
        school: "浙江大学",
        educationType: "统招全日制",
        studyMode: "联合培养",
        laboratory: "CAD&CG 国家重点实验室",
        researchDirection: ["AIGC", "多模态生成"],
        advisor: "王老师",
        studentId: 20231234,
        academicSystem: 3,
      },
    ],
    internships: [
      {
        company: "字节跳动",
        title: "后端开发实习生",
        description: ["负责推荐服务接口开发", "支持线上稳定性治理"],
      },
    ],
    campusExperiences: [
      {
        organization: "浙江大学 ACM 协会",
        category: "学生组织",
        role: "技术负责人",
        isCurrent: true,
      },
    ],
  });

  assert.equal(normalized.educations[0].educationType, "全日制");
  assert.equal(normalized.educations[0].studyMode, "联合培养");
  assert.equal(normalized.educations[0].laboratory, "CAD&CG 国家重点实验室");
  assert.equal(normalized.educations[0].researchDirection, "AIGC, 多模态生成");
  assert.equal(normalized.educations[0].advisor, "王老师");
  assert.equal(normalized.educations[0].studentId, "20231234");
  assert.equal(normalized.educations[0].academicSystem, "3");
  assert.equal(normalized.internships[0].company, "字节跳动");
  assert.equal(
    normalized.internships[0].description,
    "负责推荐服务接口开发, 支持线上稳定性治理"
  );
  assert.equal(normalized.campusExperiences[0].category, "学生组织");
  assert.equal(normalized.campusExperiences[0].isCurrent, "是");
});

test("resume schema preserves flexible date precision and legacy aliases", () => {
  const schema = loadResumeSchema();
  const normalized = schema.normalizeResumeProfile({
    personal: {
      birthYearMonth: "2001/06",
    },
    contactAndLocation: {
      nativePlace: "江西南昌",
    },
    identityAndAuthorization: {
      idCardNumber: "362202200106265976",
    },
    educations: [
      {
        learningModality: "全国普通高等院校全日制",
        schoolSystem: "2年及以上",
        timeRange: "2021年09月 至 2025年06月",
      },
    ],
  });

  assert.equal(normalized.personal.birthDate, "2001-06");
  assert.equal(normalized.contactAndLocation.hometownCity, "江西南昌");
  assert.equal(normalized.contactAndLocation.hometownProvince, "江西南昌");
  assert.equal(
    normalized.identityAndAuthorization.idCardNumber,
    "362202200106265976"
  );
  assert.equal(normalized.identityAndAuthorization.personalIdType, undefined);
  assert.equal(normalized.educations[0].studyMode, "统招");
  assert.equal(normalized.educations[0].academicSystem, "2年及以上");
  assert.equal(normalized.educations[0].startDate, "2021-09");
  assert.equal(normalized.educations[0].endDate, "2025-06");
});


test("identity data stays archived and is excluded from all fill interfaces", () => {
  const schema = loadResumeSchema();
  const input = { identityAndAuthorization: { personalIdNumber: "110101200001010011", extra: "保留" } };
  const normalized = schema.normalizeResumeProfile(input);
  assert.deepEqual(normalized.identityAndAuthorization, input.identityAndAuthorization);
  assert.equal(normalized.personal.birthDate, "");
  assert.equal(schema.hasAnyFilledField(normalized), false);
  assert.equal(schema.sections.some(s => s.key === "identityAndAuthorization"), false);
  assert.equal(schema.getFieldCatalog().some(f => f.path.startsWith("identityAndAuthorization.")), false);
  assert.equal(schema.createImportTemplateString().includes("identityAndAuthorization"), false);
  assert.equal("identityAndAuthorization" in schema.getFillProfile(normalized), false);
});

test("legacy publications and patents migrate once without losing free text", () => {
  const schema = loadResumeSchema();
  const raw = { additional: { publications: "论文一，期刊 A\n论文二，期刊 B", patents: "专利一，授权", customNotes: "备注" } };
  const profile = schema.normalizeResumeProfile(raw);
  assert.equal(profile.personalAchievements.length, 2);
  assert.equal(profile.personalAchievements[0].name, raw.additional.publications);
  assert.equal(profile.personalAchievements[0].description, "");
  assert.equal(profile.personalAchievements[0].date, "");
  assert.equal(profile.personalAchievements[1].name, raw.additional.patents);
  assert.equal(profile.additional.customNotes, "备注");
  assert.equal(profile.additional.publications, undefined);
  assert.deepEqual(schema.normalizeResumeProfile(profile), profile);
  const deleted = structuredClone(profile);
  deleted.personalAchievements.splice(0, 1);
  assert.equal(schema.normalizeResumeProfile(deleted).personalAchievements.length, 1);
});

test("full achievement lists preserve pending legacy text and migrate when room exists", () => {
  const schema = loadResumeSchema();
  const input = { personalAchievements: Array.from({length: 10}, (_, i) => ({name: `论文 ${i}`})), additional: {patents: "旧专利"} };
  const full = schema.normalizeResumeProfile(input);
  assert.equal(full.personalAchievements.length, 10);
  assert.equal(full.additional.patents, "旧专利");
  full.personalAchievements.pop();
  const migrated = schema.normalizeResumeProfile(full);
  assert.equal(migrated.personalAchievements[9].name, "旧专利");
  assert.equal(migrated.additional.patents, undefined);
});

test("achievements expose only name, description and date while preserving date precision", () => {
  const schema = loadResumeSchema();
  const raw = { personalAchievements: [{name: "研究论文", description: "多模态研究", type: "论文", date: "2025年06月", affiliation: "Nature", url: "https://example.com/paper"}], skills: {primarySkills: "JS"}, languages: [{name: "英语"}], certificates: [{name: "CET-6"}] };
  const profile = schema.normalizeResumeProfile(raw);
  assert.equal(profile.personalAchievements[0].date, "2025-06");
  assert.equal(profile.personalAchievements[0].description, "多模态研究");
  assert.equal(profile.personalAchievements[0].type, undefined);
  assert.equal(profile.personalAchievements[0].affiliation, undefined);
  assert.equal(profile.personalAchievements[0].url, undefined);
  assert.equal(profile.skills.primarySkills, "JS");
  assert.equal(profile.languages[0].name, "英语");
  assert.equal(profile.certificates[0].name, "CET-6");
  assert.equal(schema.getCatalogWithValues(profile).filter(f => f.hasValue && f.sectionKey === "personalAchievements").length, 3);
  assert.equal(JSON.parse(schema.createImportTemplateString()).personalAchievements.length, 10);
});

test("online profiles migrate supported links and removed fields stay excluded", () => {
  const schema = loadResumeSchema();
  const profile = schema.normalizeResumeProfile({
    contactAndLocation: { githubUrl: "https://github.com/new", websiteUrl: "" },
    onlinePresence: {
      githubUrl: "https://github.com/legacy",
      websiteUrl: "https://legacy.example.com",
      linkedinUrl: "https://linkedin.com/in/legacy",
    },
    jobPreferences: { targetRole: "工程师" },
  });

  assert.equal(profile.contactAndLocation.githubUrl, "https://github.com/new");
  assert.equal(profile.contactAndLocation.websiteUrl, "https://legacy.example.com");
  assert.equal(profile.contactAndLocation.linkedinUrl, undefined);
  assert.equal(profile.onlinePresence, undefined);
  assert.equal(profile.jobPreferences, undefined);
  assert.equal(schema.sections.some((section) => section.key === "onlinePresence" || section.key === "jobPreferences"), false);
  assert.equal(schema.getFieldCatalog().some((field) => field.path.startsWith("onlinePresence.") || field.path.startsWith("jobPreferences.")), false);
  const template = JSON.parse(schema.createImportTemplateString());
  assert.equal(template.onlinePresence, undefined);
  assert.equal(template.jobPreferences, undefined);
  assert.equal(template.contactAndLocation.githubUrl, "");
});

test("zh-CN schema removes redundant fields and keeps contextual date labels", () => {
  const schema = loadResumeSchema();
  const removedPaths = [
    "personal.firstName",
    "personal.middleName",
    "personal.lastName",
    "personal.preferredName",
    "personal.englishName",
    "personal.alternateEmail",
    "personal.alternatePhone",
    "personal.phoneCountryCode",
    "contactAndLocation.currentAddressLine2",
    "contactAndLocation.timezone",
    "contactAndLocation.linkedinUrl",
    "skills.managementExperience",
    "skills.softSkills",
    "skills.notableAchievements",
    "projects.0.demoUrl",
    "additional.volunteerExperience",
    "additional.competitions",
    "additional.openSourceContributions",
    "additional.references",
  ];
  const catalog = schema.getFieldCatalog({ mode: "initial" });
  const paths = new Set(catalog.map((field) => field.path));
  removedPaths.forEach((fieldPath) => assert.equal(paths.has(fieldPath), false, fieldPath));

  assert.equal(schema.version, 7);
  assert.equal(catalog.find((field) => field.path === "educations.0.startDate").label, "教育经历 1 / 入学时间");
  assert.equal(catalog.find((field) => field.path === "educations.0.endDate").label, "教育经历 1 / 毕业时间");
  assert.equal(catalog.find((field) => field.path === "workExperiences.0.startDate").label, "工作经历 1 / 入职时间");
  assert.equal(catalog.find((field) => field.path === "workExperiences.0.endDate").label, "工作经历 1 / 离职时间");

  const normalized = schema.normalizeResumeProfile({
    personal: { fullName: "张三", englishName: "Sam Zhang" },
    projects: [{ name: "项目", demoUrl: "https://demo.example.com" }],
  });
  assert.equal(normalized.personal.fullName, "张三");
  assert.equal(normalized.personal.englishName, undefined);
  assert.equal(normalized.projects[0].demoUrl, undefined);
});
