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
| PUT | `/transactions/:id` | Edita. `scope`: `single` \| `future` \| `all` para séries |
| DELETE | `/transactions/:id?scope=` | Exclui com o mesmo escopo |
| GET | `/dashboard/summary?month=` | Totais do mês, mês anterior, cartão, meta, disponível e total guardado |
| GET | `/dashboard/evolution?from=YYYY-MM&months=6` | Entradas/saídas mês a mês (uma consulta) |
| GET | `/dashboard/distribution?month=` | Gastos por categoria, incluindo "Sem categoria" |
| GET/POST | `/budgets` | Orçamentos do mês com gasto / cria ou atualiza limite |
| POST | `/budgets/copy` | Copia orçamentos de `from_month` para `to_month` |
| DELETE | `/budgets/:id` | Exclui orçamento |
| GET/POST | `/goals` | Meta de economia do mês (`savings_goal: 0` remove) |
| PUT | `/savings` | Ajusta o total guardado para `manual_total` |

## Regras de negócio

- Valores são validados e convertidos em centavos; parcelas somam exatamente o total (a diferença de centavos vai para a última).
- Datas mensais respeitam o fim do mês (31/01 + 1 mês = 28/02).
- Lançamentos de cartão: `date` = 1º dia do mês da fatura, `purchase_date` = data da compra.
- **Total guardado** = entradas − saídas desde `SAVINGS_START_DATE` (`src/services/savings.ts`) **até hoje**, mais o ajuste manual. Parcelas e lançamentos futuros só entram quando a data chega.
- Toda consulta e alteração é filtrada pelo usuário do token, inclusive a categoria informada em lançamentos e orçamentos.
