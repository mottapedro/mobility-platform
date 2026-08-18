import { Prisma } from "@prisma/client";

// Campos públicos de User serializáveis na API.
//
// P0 (incidente): GET /rides/:id, POST /rides e os endpoints de lifecycle
// retornavam o usuário completo (passwordHash incluído) via `include: { user:
// true }` — o bcrypt atravessava a fronteira HTTP em passenger.user e
// selectedDriver.user. passwordHash, tokens e segredos jamais devem ser
// serializados. Use este select em qualquer include/select de User destinado
// a resposta HTTP.
export const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  createdAt: true,
} satisfies Prisma.UserSelect;