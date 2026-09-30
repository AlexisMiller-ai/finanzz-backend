# Finanzz — backend

API REST do Finanzz. Express 5 + TypeScript + PostgreSQL (`pg`), autenticação JWT. Deploy na Vercel (`api/index.ts`).

## Rodando

```bash
npm install
npm run dev        # http://localhost:3333
npm run typecheck
npm run migrate    # aplica db/migrations/*.sql no DATABASE_URL
```

Variáveis de ambiente (`.env`):

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | Conexão PostgreSQL |
| `JWT_SECRET` | Chave dos tokens. **Obrigatória em produção** |
| `PORT` | Porta local (padrão 3333) |
| `DATABASE_SSL` | `false` para desativar SSL (automático para localhost) |
| `CRON_SECRET` | Protege `/keep-alive`. Se definida, exige `Authorization: Bearer <segredo>` |

Banco novo: rode `db/schema.sql` e depois `npm run migrate`. As migrations são aditivas e idempotentes.

## Endpoints

Todas as rotas, exceto `/auth/register`, `/auth/login` e `/health`, exigem `Authorization: Bearer <token>`.

| Método | Rota | Descrição |
| --- | --- | --- |
| POST | `/auth/register`, `/auth/login` | Cria conta / entra (e-mail sem diferença de maiúsculas) |
| GET/PUT | `/auth/me` | Dados do usuário / altera o nome |
| PUT | `/auth/password` | Troca de senha (`current_password`, `new_password`) |
| GET/POST | `/categories` | Lista (com `transaction_count`) / cria |
| PUT/DELETE | `/categories/:id` | Edita / exclui (lançamentos ficam sem categoria) |
| GET | `/transactions?month=YYYY-MM` | Lançamentos do mês com nome e cor da categoria |
| POST | `/transactions` | Cria. `installments` (+`is_installment`) para parcelar, `repeat_months` para fixo mensal |
| POST | `/transactions/import` | Importa em lote; `dry_run: true` só analisa e aponta duplicados |
| PUT | `/transactions/:id` | Edita. `scope`: `single` \| `future` \| `all` para séries |
| DELETE | `/transactions/:id?scope=` | Exclui com o mesmo escopo |
| GET | `/dashboard/summary?month=` | Totais do mês, mês anterior, cartão, meta, disponível e total guardado |
| GET | `/dashboard/evolution?from=YYYY-MM&months=6` | Entradas/saídas mês a mês (uma consulta) |
| GET | `/dashboard/distribution?month=` | Gastos por categoria, incluindo "Sem categoria" |
| GET/POST | `/budgets` | Orçamentos do mês com gasto / cria ou atualiza limite |
| POST | `/budgets/copy` | Copia orçamentos de `from_month` para `to_month` |
| DELETE | `/budgets/:id` | Exclui orçamento |
| GET/POST | `/keep-alive` | Registra atividade no banco (ver "Manter o banco ativo") |
| GET/POST | `/goals` | Meta de economia do mês (`savings_goal: 0` remove) |
| PUT | `/savings` | Ajusta o total guardado para `manual_total` |

## Regras de negócio

- Valores são validados e convertidos em centavos; parcelas somam exatamente o total (a diferença de centavos vai para a última).
- Datas mensais respeitam o fim do mês (31/01 + 1 mês = 28/02).
- Lançamentos de cartão: `date` = 1º dia do mês da fatura, `purchase_date` = data da compra.
- **Total guardado** = entradas − saídas desde `SAVINGS_START_DATE` (`src/services/savings.ts`) **até hoje**, mais o ajuste manual. Parcelas e lançamentos futuros só entram quando a data chega.
- **Importação**: cada linha guarda um `external_id` (FITID do OFX ou hash da linha do CSV). Um índice único por usuário impede reimportar o mesmo arquivo; sem esse identificador, a comparação é por data + valor + tipo + descrição, contando ocorrências (duas compras iguais no mesmo dia continuam sendo duas).
- Toda consulta e alteração é filtrada pelo usuário do token, inclusive a categoria informada em lançamentos e orçamentos.

## Manter o banco ativo

O projeto do Supabase no plano free é **pausado após 7 dias sem atividade**, e despausar só é possível manualmente no painel. Para evitar isso, `/keep-alive` faz uma **escrita** na tabela `app_heartbeat` e é chamado por dois agendadores independentes:

1. **Cron da Vercel** (`vercel.json`): todo dia às 9:00 UTC. É o principal.
2. **GitHub Actions** (`.github/workflows/keep-alive.yml`): a cada 2 dias, com 3 tentativas. É a rede de segurança e, se falhar, o GitHub envia e-mail.

Configuração opcional, mas recomendada:

- Variável de ambiente `CRON_SECRET` no projeto da Vercel (a Vercel envia esse valor no cron automaticamente).
- O mesmo valor em *Settings → Secrets and variables → Actions → New repository secret*, com o nome `CRON_SECRET`.

Para conferir quando foi o último sinal:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://finanzz-backend.vercel.app/keep-alive?source=manual"
```

A resposta traz `daysSincePreviousPing`: se esse número se aproximar de 7, algum agendador parou de rodar. O GitHub também desativa agendamentos em repositórios sem commits por 60 dias (avisa por e-mail; basta reativar na aba Actions).
