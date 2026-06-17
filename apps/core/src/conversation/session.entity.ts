import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Entity({ name: "conversation_session" })
export class ConversationSessionRow {
  @PrimaryColumn({ type: "varchar", length: 64 })
  id!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  lastActiveAt!: Date;
}
