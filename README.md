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
| GET/POST | `/accounts` | Contas com saldo calculado / cria conta |
| PUT/DELETE | `/accounts/:id` | Edita (inclui arquivar) / exclui conta sem lançamentos |
| PUT | `/accounts/:id/balance` | Informa o saldo atual e recalcula o saldo inicial |
| PUT | `/cards/:id/outstanding` | Informa quanto o cartão deve hoje e guarda a diferença como ajuste |
| GET/POST | `/cards` | Cartões com fatura do mês (`?month=`) e saldo devedor / cria cartão |
| PUT/DELETE | `/cards/:id` | Edita / exclui cartão sem lançamentos |
| GET | `/cards/:id/bills` | Faturas do cartão mês a mês, com situação (paga / a pagar / aberta) |
| POST/DELETE | `/cards/:id/bills/:month/pay` | Dá baixa numa fatura (`YYYY-MM`) / desfaz a baixa |
| POST | `/cards/:id/bills/settle-past` | Dá baixa em todas as faturas que já fecharam |
| GET | `/transactions/upcoming` | Contas a pagar e a receber: vencidas e dos próximos dias (`?days=7`) |
| GET | `/budgets/suggestions` | Limite sugerido pela média dos 3 meses anteriores (`?month=`) |
| DELETE | `/budgets/category/:categoryId` | Encerra o orçamento a partir do mês (`?month=&scope=so_este_mes` pausa só aquele mês) |
| GET | `/reports` | Relatório de um período livre (`?from=&to=`), com comparação e categorias |
| PUT | `/transactions/:id/settle` | Marca como pago/recebido (`settled: false` volta a pendente) |
| POST | `/transfers` | Transferência entre contas ou pagamento de fatura (conta → cartão) |
| DELETE | `/transfers/:transferId` | Exclui as duas pontas |
| GET/POST | `/categories` | Lista (com `transaction_count`) / cria |
| PUT/DELETE | `/categories/:id` | Edita / exclui (lançamentos ficam sem categoria) |
| GET | `/transactions?month=YYYY-MM` | Lançamentos do mês com nome e cor da categoria |
| POST | `/transactions` | Cria. `installments` (+`is_installment`) para parcelar, `repeat_months` para fixo mensal |
| POST | `/transactions/import` | Importa em lote; `dry_run: true` só analisa e aponta duplicados |
| POST | `/transactions/move` | Move vários lançamentos para outra conta ou cartão |
| POST | `/transactions/reconcile` | Marca lançamentos manuais como já conferidos com o arquivo do banco |
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
- **Contas e cartões**: todo lançamento fica numa conta **ou** num cartão (restrição no banco garante que nunca nos dois). Despesa no crédito vai para o cartão; o resto, para a conta. Sem escolha explícita, usa a primeira conta/cartão do usuário e cria uma se não houver nenhuma.
- **Saldo da conta** = saldo inicial + entradas − saídas, considerando só lançamentos até hoje (parcelas e agendamentos futuros não mexem no saldo de agora). `PUT /accounts/:id/balance` faz o caminho inverso: recebe o saldo real de hoje e deduz o inicial.
- **Orçamento recorrente**: uma linha em `budgets` significa "a partir deste mês, o limite é X" e vale para os meses seguintes até existir outra linha da mesma categoria; `active = false` encerra a partir daquele mês sem apagar o histórico. Mudanças com `scope: "so_este_mes"` gravam também o mês seguinte com o valor anterior, para não vazar. Cada orçamento devolve a média dos 3 meses anteriores, a projeção do mês corrente no ritmo atual e um `pace` (`ok`, `atencao`, `vai_estourar`, `estourou`).
- **Relatório** (`/reports`): recebe um período livre (padrão: últimos 6 meses) e devolve totais, categorias com média mensal e variação contra o **período anterior de mesmo tamanho**, linha do tempo (por semana até ~3 meses, por mês acima disso) e os maiores gastos. Transferências ficam de fora; pendentes entram nos totais e são informados à parte.
- **Pendência** (`settled`): um lançamento nasce efetivado, salvo quando o formulário manda `settled: false` — aí é conta a pagar (despesa) ou a receber (receita). O que está pendente fica fora do saldo da conta e do total guardado, mesmo com a data já vencida; os totais do mês continuam somando tudo, porque são o resultado do mês. Parcelas e repetições a partir da segunda nascem pendentes. Compra no cartão e transferência não têm pendência própria (restrição no banco garante): no cartão quem recebe baixa é a fatura, e transferência é dinheiro que já mudou de lugar.
- **Fatura aberta**: a partir do dia de fechamento, a compra já entra na fatura do mês seguinte — é a mesma regra do formulário de lançamento. `openBillMonth` é a fatura que ainda recebe compras; o que vem depois dela é parcela futura (`futureInstallments`).
- **Cartão**: `billTotal` é a fatura do mês consultado; `closedDue` é o que sobrou das faturas que já fecharam e não receberam baixa; `outstanding` = `closedDue` + o que já caiu na fatura aberta. `outstanding_adjustment` corrige faturas antigas pagas fora do app e entra no cálculo.
- **Baixa de fatura** (`card_bills`, uma linha por mês de referência): `transferencia` cria o pagamento saindo da conta (o lançamento é que abate a dívida), `externo` foi pago fora do app (o valor é descontado aqui) e `lancado` só marca como paga porque o pagamento já estava lançado. O desconto de uma baixa `externo` nunca passa da dívida daquele mês: se as compras saírem do cartão depois (mudança de cartão, exclusão), o crédito encolhe junto em vez de virar saldo a favor. `settle-past` dá baixa em tudo que já fechou e zera o ajuste manual.
- **Transferência** grava duas linhas com o mesmo `transfer_id`: muda os saldos, mas fica fora de entradas, saídas, distribuição, evolução, orçamentos e total guardado. Pagar a fatura é uma transferência conta → cartão, e abate o saldo devedor do cartão.
- **Conciliação**: na pré-visualização, cada linha do arquivo procura um lançamento manual do usuário (sem `external_id`) do mesmo tipo, com valor igual (ou até 15% de diferença, no máximo R$ 30) e data até 3 dias de distância. `/transactions/reconcile` grava o `external_id` nesse lançamento — sem duplicar — e pode corrigir o valor para o do banco.
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
