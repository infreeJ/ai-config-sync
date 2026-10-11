import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';

export function validateCatalogMappings(root, config, catalogs, editedProviders) {
  const errors = [];
  const warnings = [];
  if (editedProviders.length === 0) return { errors, warnings };
  const directory = join(root, 'sources', 'agents');
  const agents = existsSync(directory) ? readdirSync(directory)
    .filter((name) => !name.startsWith('.') && name.toLowerCase().endsWith('.md') && statSync(join(directory, name)).isFile())
    .map((name) => ({ name, meta: parseFrontmatter(readFileSync(join(directory, name), 'utf8'), join(directory, name)).meta })) : [];
  for (const provider of editedProviders) {
    const catalog = catalogs[provider];
    if (catalog?.status !== 'ready') { errors.push(`${provider}: 조회에 실패하여 프리셋 변경을 저장할 수 없습니다. 재조회해 주세요.`); continue; }
    if (agents.length === 0) warnings.push(`${provider}: 원본 에이전트가 없어 모델·추론 조합을 확인할 수 없습니다. 원본 작성 후 설정을 다시 확인해 주세요.`);
    for (const { name, meta } of agents) {
      const model = meta.model ? config.modelPresets[meta.model]?.[provider] : undefined;
      const effort = meta.effort ? config.effortPresets[meta.effort]?.[provider] : undefined;
      const prefix = `${provider} / ${name} (model: ${meta.model || '상속'}, effort: ${meta.effort || '상속'})`;
      if (meta.model && !model) {
        errors.push(`${prefix}: 모델 프리셋 매핑이 누락되었습니다. 원본과 설정의 프리셋을 확인해 주세요.`);
        continue;
      }
      if (meta.effort && !effort) {
        errors.push(`${prefix}: 추론 프리셋 매핑이 누락되었습니다. 원본과 설정의 프리셋을 확인해 주세요.`);
        continue;
      }
      if (!model || model === 'inherit') {
        warnings.push(`${prefix}: 모델을 상속하므로 추론 수준 지원 여부를 확인할 수 없습니다.`);
        continue;
      }
      const info = catalog.models.find((candidate) => candidate.value === model || candidate.resolvedModel === model);
      if (!info) { errors.push(`${prefix}: 모델 ${model}이 조회 목록에 없습니다. 모델 프리셋을 수정해 주세요.`); continue; }
      if (meta.effort) {
        if (info.efforts === null) errors.push(`${prefix}: ${model}의 추론 지원 정보를 확인할 수 없습니다. CLI를 업데이트하거나 effort를 생략해 주세요.`);
        else if (!info.efforts.includes(effort)) errors.push(`${prefix}: ${model}은 ${effort ?? '누락된 추론 값'}을 지원하지 않습니다 (지원: ${info.efforts.join(', ') || '없음'}). 프리셋을 수정해 주세요.`);
      }
    }
  }
  return { errors, warnings };
}
