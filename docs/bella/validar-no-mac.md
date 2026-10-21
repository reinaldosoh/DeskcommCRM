# Validar a Bella no seu Mac

Tudo roda no próprio Mac: nada vai para a VPS. Leva uns 20 minutos na primeira
vez, por causa do download das imagens do Supabase e do WAHA.

## 0. O que já tem no Mac

Docker com Colima, Supabase CLI, Node 22 e pnpm já estão instalados. Antes de
começar, ligue o Colima:

```bash
colima start --cpu 4 --memory 8
```

## 1. Pegar a versão com a Bella

```bash
cd ~/Desktop/DeskcommCRM
git status                      # se tiver alteração sua pendente, guarde antes (git stash)
git fetch origin feat/pacare-bella
git checkout feat/pacare-bella
pnpm install
```

## 2. Testar a Bella sem subir nada (1 minuto)

```bash
pnpm bella:lab
```

Roda os 9 cenários tirados do teste com a Mia: cliente que fecha à vista,
"só consigo 100 por mês", número errado, CPF errado três vezes, "isso é golpe?",
"me chama semana que vem", opt-out depois do acordo, pedido de humano e pedido
de 50% de desconto. Também roda o controle: a conversa como a Mia fez (fecha e
não manda o pagamento) tem de ser REPROVADA.

Com uma chave da Anthropic, a Bella conversa de verdade com um devedor simulado
por IA, e cada mensagem dela passa pelo guardrail:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm bella:lab --modelo --juiz
```

## 3. Subir o produto inteiro

```bash
pnpm local:up
```

Na primeira vez ele gera o `.env.local` sozinho. Se já existir um `.env.local`
de outro ambiente, ele é guardado como `.env.local.cloud-backup` antes.

Crie o usuário dono (troque o e-mail e a senha):

```bash
OWNER_EMAIL=voce@exemplo.com OWNER_PASSWORD='uma-senha-forte' OWNER_ORG_NAME='Pacare Local' \
  pnpm exec tsx scripts/bootstrap-owner.ts
```

## 4. Criar a carteira de teste e a Bella

```bash
pnpm bella:semear --telefone +5522999999999 --cpf3 157
```

- `--telefone`: o WhatsApp que faz o papel do devedor (o seu).
- `--cpf3`: os 3 dígitos que a Bella vai pedir. Invente; não precisa ser CPF real.

Isso cria o devedor "João Carlos" com a mesma dívida do teste da Mia
(R$ 3.769,76 no cartão do Banco Nova Era) e a Bella como rascunho. Pode rodar de
novo quando quiser recomeçar o teste: a dívida volta a "aberta" do zero.

## 5. Conversar com ela pelo WhatsApp

1. Abra o endereço que o `pnpm local:up` mostrou (normalmente http://localhost:3000) e entre com o usuário do passo 3.
2. Em Provedores de IA, conecte o seu plano do ChatGPT pelo login (sem chave) ou cadastre uma chave de API da Anthropic. Para a Bella já nascer usando o plano do ChatGPT, rode o passo 4 com `--provedor openai-assinatura --modelo <modelo que a tela mostrar>`.
3. Em Conexões, conecte um número de TESTE pelo QR code (não use o número de produção).
4. Em Agentes, abra a Bella, publique e ligue ao número de teste.
5. Do seu WhatsApp (o do `--telefone`), mande "oi" para o número de teste e negocie.

O PIX e o boleto que ela manda são de teste: o copia-e-cola tem o formato real,
mas a chave não existe em nenhum banco, e o boleto vem marcado "NÃO PAGUE".

## Parar tudo

```bash
pnpm local:down
colima stop
```

## Se algo falhar

- `sha512sum: command not found`: `brew install coreutils` e rode `pnpm local:up` de novo.
- Porta 3000 ocupada: o `local:up` escolhe a próxima livre e mostra qual.
- Logs: `pnpm local:logs` (ou `bash scripts/local-stack.sh logs worker`).
