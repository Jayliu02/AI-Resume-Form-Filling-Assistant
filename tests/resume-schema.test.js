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

  assert.equal(normalized.educations[0].educationType, "统招全日制");
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
  assert.equal(profile.personalAchievements[0].type, "论文");
  assert.equal(profile.personalAchievements[0].name, raw.additional.publications);
  assert.equal(profile.personalAchievements[0].date, "");
  assert.equal(profile.personalAchievements[1].type, "专利");
  assert.equal(profile.additional.customNotes, "备注");
  assert.equal(profile.additional.publications, undefined);
  assert.deepEqual(schema.normalizeResumeProfile(profile), profile);
  const deleted = structuredClone(profile);
  deleted.personalAchievements.splice(0, 1);
  assert.equal(schema.normalizeResumeProfile(deleted).personalAchievements.length, 1);
});

test("full achievement lists preserve pending legacy text and migrate when room exists", () => {
  const schema = loadResumeSchema();
  const input = { personalAchievements: Array.from({length: 10}, (_, i) => ({name: `论文 ${i}`, type: "论文"})), additional: {patents: "旧专利"} };
  const full = schema.normalizeResumeProfile(input);
  assert.equal(full.personalAchievements.length, 10);
  assert.equal(full.additional.patents, "旧专利");
  full.personalAchievements.pop();
  const migrated = schema.normalizeResumeProfile(full);
  assert.equal(migrated.personalAchievements[9].name, "旧专利");
  assert.equal(migrated.additional.patents, undefined);
});

test("achievements expose all mapping fields and preserve journal, level and date precision", () => {
  const schema = loadResumeSchema();
  const raw = { personalAchievements: [{name: "研究论文", type: "论文", date: "2025年06月", affiliation: "Nature", url: "https://example.com/paper"}], skills: {primarySkills: "JS"}, languages: [{name: "英语"}], certificates: [{name: "CET-6"}] };
  const profile = schema.normalizeResumeProfile(raw);
  assert.equal(profile.personalAchievements[0].date, "2025-06");
  assert.equal(profile.personalAchievements[0].affiliation, "Nature");
  assert.equal(profile.skills.primarySkills, "JS");
  assert.equal(profile.languages[0].name, "英语");
  assert.equal(profile.certificates[0].name, "CET-6");
  assert.equal(schema.getCatalogWithValues(profile).filter(f => f.hasValue && f.sectionKey === "personalAchievements").length, 5);
  assert.equal(JSON.parse(schema.createImportTemplateString()).personalAchievements.length, 10);
});
