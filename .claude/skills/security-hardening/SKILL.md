---
name: security-hardening
description: Pensamiento de atacante sobre una feature, archivo, o superficie de Worgena. Threat model con STRIDE + checklist de invariantes de seguridad + recomendaciones priorizadas. Cargar cuando el founder pida "¿esto es seguro?", "hacé threat model de X", antes de mergear features que tocan data de clientes, o cuando se está por guardar data sensible.
---

# security-hardening

> Skill portada desde Mavis. Original: `C:\Users\acer\.mavis\agents\wozniak\skills\security-hardening\SKILL.md`. Las `references/` viven en el original.

Pensamiento de atacante sobre una feature, archivo, o superficie de Worgena. Threat model mínimo + checklist + recomendaciones.

## Cuándo cargar esta skill

- "¿Esto es seguro?"
- "Hacé threat model de X"
- "Revisá la seguridad antes de mergear"
- "Estamos guardando data sensible de cliente — ¿qué se rompe?"

## Procedimiento

1. **Mapear la superficie**:
   - ¿Qué datos entran? (input del usuario, de otro sistema, del LLM)
   - ¿Qué datos salen? (a dónde, con qué auth)
   - ¿Qué datos se persisten? (en qué tabla, con qué encryption, por cuánto)
   - ¿Quién tiene acceso? (roles, tenants, agentes)
2. **Aplicar STRIDE** (1 pasada rápida):

| Categoría | Pregunta |
|---|---|
| **Spoofing** | ¿Puede alguien hacerse pasar por otro tenant/usuario/agente? |
| **Tampering** | ¿Puede alguien modificar data en tránsito o en reposo? |
| **Repudiation** | ¿Queda registro de quién hizo qué? (audit log) |
| **Information disclosure** | ¿Se puede filtrar data de un tenant a otro? ¿A un usuario que no debe ver? |
| **Denial of service** | ¿Un request malicioso puede tumbar el sistema para todos? |
| **Elevation of privilege** | ¿Un usuario/agente puede hacer cosas que no debería? |

3. **Checklist específica de Worgena**:
   - [ ] **Tenant isolation**: ¿el `tenant_id` está en TODA query? ¿Las keys en stores tienen el tenant como parte del key?
   - [ ] **Prompt injection**: ¿El input del usuario llega al prompt del LLM sin sanitizar? ¿Puede un usuario hacer que el agente ejecute algo fuera de su scope?
   - [ ] **Secrets management**: ¿Hay API keys en código? ¿En logs? ¿En la DB?
   - [ ] **HITL gates**: ¿Las acciones destructivas (delete, download masivo, send a cliente final) tienen gate humano?
   - [ ] **Audit log**: ¿Cada acción del agente queda registrada con timestamp, tenant_id, user_id, agent_id, action, model, cost, prompt_hash, response_hash?
   - [ ] **Error al cliente**: ¿El mensaje de error al cliente final es genérico? (Stack trace solo al log)
   - [ ] **Apify / scraping**: ¿El budget por tenant por día está cappeado?
   - [ ] **Topic-based policies**: ¿Cada acción del agente está bajo una policy? ¿La policy está testeada?
4. **Evaluar LLM-specific risks**:
   - **Prompt injection directa**: usuario mete instrucciones en el input.
   - **Prompt injection indirecta**: el LLM lee un doc externo que tiene instrucciones maliciosas.
   - **Exfiltración via tools**: el agente usa una tool (Apify, web search) para sacar data.
   - **Cost amplification**: el usuario hace que el agente gaste miles de tokens sin sentido.
5. **Devolver**:

```
SUPERFICIE: <resumen en 1 línea>

STRIDE: (cada categoría con riesgo + mitigación)

CHECKLIST WORGENA: (cada item con ✓/✗/⚠)

RIESGOS CRÍTICOS (acción inmediata): 1, 2, 3...
RIESGOS MAYORES (próximo sprint): 1, 2, 3...
OPORTUNIDADES DE MEJORA: 1, 2, 3...
TEST QUE FALTA: 1, 2, 3...
```

## References (leer desde Mavis original)

- `C:\Users\acer\.mavis\agents\wozniak\skills\security-hardening\references\multi-tenant-isolation.md` — patrones de aislamiento y por qué en Worgena se eligió row-level
- `…\references\audit-log-patterns.md` — qué se loguea, cómo se estructura, retención
- `…\references\hitl-design.md` — cuándo forzar gate humano, cómo se implementa, UX
- `…\references\llm-prompt-injection.md` — vectores de ataque específicos del LLM, mitigaciones

## Anti-patrones

- "Es interno, no importa" → importa, igual. Internal tools se vuelven externos.
- "Lo encriptamos en tránsito con HTTPS, listo" → en reposo también.
- "El LLM no puede hacer daño" → puede, indirectamente. Por eso existen las policies.
- "No tenemos tiempo" → no se skipea. Se agrega al sprint como item.

## Salida esperada

Un reporte accionable. Los críticos van al sprint actual. Los mayores al próximo sprint. Las oportunidades se priorizan. Lo que ya está bien se marca con check verde, no se discute más.
