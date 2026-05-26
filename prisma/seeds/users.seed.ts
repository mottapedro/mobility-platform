import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const USERS = [
  { name: "Pedro Paulo Motta", email: "mottapedro01@gmail.com", phone: "21981722517", role: "DRIVER" as const },
  { name: "Carlos Silva",      email: "carlos@driver.com",       phone: "11999990001", role: "DRIVER" as const },
  { name: "Marcos Lima",       email: "marcos@driver.com",       phone: "11999990002", role: "DRIVER" as const },
  { name: "Roberto Souza",     email: "roberto@driver.com",      phone: "11999990003", role: "DRIVER" as const },
  { name: "João Luiz Brito",   email: "jlcbrito@driver.com",    phone: "11999990004", role: "DRIVER" as const },
  { name: "Ana Claudia",       email: "ana@passenger.com",       phone: "11999990005", role: "PASSENGER" as const },
  { name: "Bruno Reis",        email: "bruno@passenger.com",     phone: "11999990006", role: "PASSENGER" as const },
];

export async function seedUsers(prisma: PrismaClient) {
  const passwordHash = await bcrypt.hash("123456", 10);

  for (const u of USERS) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { passwordHash },
      create: { ...u, passwordHash },
    });
  }

  console.log(`✅ Users criados/atualizados (${USERS.length})`);
}
